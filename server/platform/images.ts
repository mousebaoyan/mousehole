import sharp from "sharp";
import { AppError } from "./errors.ts";

// libvips caches decoded images and uses a thread per core by default; this process has little
// memory to spare, so one thread per image and two images at a time.
sharp.cache(false);
sharp.concurrency(1);
const AT_ONCE = 2;

const LARGE = 2048;
const DISPLAY = 960;
// Rejects decompression bombs: a small file that decodes into a huge picture.
const MAX_PIXELS = 40_000_000;
const FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif"]);

let running = 0;
const waiting: (() => void)[] = [];

async function oneOf<T>(job: () => Promise<T>) {
  if (running >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await job();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function invalid(): never {
  throw new AppError(400, "invalid_image", "只能上传 JPEG、PNG、WebP、GIF 或 AVIF 图片");
}

// Decoding checks it really is an image. Out comes WebP without metadata, turned upright: the
// large size at most 2048px on its long side, and for still images a 960px wide one for pages.
// Animated images keep their frames and only the large size.
export async function processImage(input: Buffer) {
  return oneOf(async () => {
    const image = sharp(input, { animated: true, limitInputPixels: MAX_PIXELS, failOn: "error" });
    const meta = await image.metadata().catch(invalid);
    if (!FORMATS.has(meta.format)) invalid();
    const animated = (meta.pages ?? 1) > 1;
    const large = await image
      .clone()
      .rotate()
      .resize({ width: LARGE, height: LARGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true })
      .catch(invalid);
    const display = animated
      ? null
      : await image
          .clone()
          .rotate()
          .resize({ width: DISPLAY, withoutEnlargement: true })
          .webp({ quality: 78 })
          .toBuffer()
          .catch(invalid);
    return {
      large: large.data,
      display,
      width: large.info.width,
      // An animated image's height covers every frame stacked.
      height: large.info.pageHeight ?? large.info.height,
      animated,
    };
  });
}

// Avatars show at 40px at most, so 96px covers screens at twice the density. An animated
// picture keeps its first frame.
const AVATAR = 96;

export async function processAvatar(input: Buffer) {
  return oneOf(async () => {
    const image = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "error" });
    const meta = await image.metadata().catch(invalid);
    if (!FORMATS.has(meta.format)) invalid();
    return image
      .rotate()
      .resize(AVATAR, AVATAR, { fit: "cover" })
      .webp({ quality: 80 })
      .toBuffer()
      .catch(invalid);
  });
}

type Size = { width: number; height: number };
export type Region = Size & { left: number; top: number };

// Cuts each region out of the picture turned upright, and fits it to its size without enlarging
// it: `still` for a still picture, `moving` for an animated one, which keeps its frames when
// `animate` allows, else only its first. Regions are in pixels of the upright picture.
export async function cropImage(
  input: Buffer,
  crops: { region: Region; still: Size; moving: Size }[],
  animate: boolean,
) {
  return oneOf(async () => {
    const image = sharp(input, {
      animated: animate,
      limitInputPixels: MAX_PIXELS,
      failOn: "error",
    });
    const meta = await image.metadata().catch(invalid);
    if (!FORMATS.has(meta.format)) invalid();
    const animated = animate && (meta.pages ?? 1) > 1;
    // An animated picture's height covers every frame stacked; such pictures carry no EXIF.
    const { width } = meta.autoOrient;
    const height = animated ? (meta.pageHeight ?? meta.height) : meta.autoOrient.height;
    if (crops.some(({ region: r }) => r.left + r.width > width || r.top + r.height > height)) {
      throw new AppError(400, "invalid_crop", "裁剪的区域超出了图片");
    }
    const files: Buffer[] = [];
    for (const { region, still, moving } of crops) {
      files.push(
        await image
          .clone()
          .autoOrient()
          .extract(region)
          .resize({ ...(animated ? moving : still), fit: "cover", withoutEnlargement: true })
          .webp({ quality: animated ? 60 : 78 })
          .toBuffer()
          .catch(invalid),
      );
    }
    return { animated, files };
  });
}
