import * as lucide from "lucide";
import type { IconNode } from "lucide";

// Lucide's icons, each written into the page as one string. With lucide-react, React rendered
// every attribute of every path, and a thread page's hundred-odd icons took a sixth of its time
// on the server. Size and strokes come from .lucide in app.css, which a size-* class overrides.
function icon(node: IconNode) {
  const markup = {
    __html: node
      .map(([tag, attrs]) => {
        const pairs = Object.entries(attrs).map(([name, value]) => ` ${name}="${value}"`);
        return `<${tag}${pairs.join("")}/>`;
      })
      .join(""),
  };
  // Labelled ones say something; the rest only decorate the text beside them.
  return function Icon({
    className,
    "aria-label": label,
  }: {
    className?: string;
    "aria-label"?: string;
  }) {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className ? `lucide ${className}` : "lucide"}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        dangerouslySetInnerHTML={markup}
      />
    );
  };
}

export type LucideIcon = ReturnType<typeof icon>;

export const ArrowDown = icon(lucide.ArrowDown);
export const ArrowLeft = icon(lucide.ArrowLeft);
export const ArrowRight = icon(lucide.ArrowRight);
export const ArrowRightLeft = icon(lucide.ArrowRightLeft);
export const ArrowUp = icon(lucide.ArrowUp);
export const AtSign = icon(lucide.AtSign);
export const Award = icon(lucide.Award);
export const Ban = icon(lucide.Ban);
export const Bell = icon(lucide.Bell);
export const BellOff = icon(lucide.BellOff);
export const BellRing = icon(lucide.BellRing);
export const Bold = icon(lucide.Bold);
export const Bookmark = icon(lucide.Bookmark);
export const Bot = icon(lucide.Bot);
export const CalendarCheck = icon(lucide.CalendarCheck);
export const ChartBar = icon(lucide.ChartBar);
export const Check = icon(lucide.Check);
export const CheckCheck = icon(lucide.CheckCheck);
export const ChevronDown = icon(lucide.ChevronDown);
export const ChevronLeft = icon(lucide.ChevronLeft);
export const ChevronRight = icon(lucide.ChevronRight);
export const ChevronUp = icon(lucide.ChevronUp);
export const CircleCheck = icon(lucide.CircleCheck);
export const CircleQuestionMark = icon(lucide.CircleQuestionMark);
export const ClipboardCheck = icon(lucide.ClipboardCheck);
export const Clock = icon(lucide.Clock);
export const Code = icon(lucide.Code);
export const Coins = icon(lucide.Coins);
export const Columns3 = icon(lucide.Columns3);
export const Copy = icon(lucide.Copy);
export const Download = icon(lucide.Download);
export const Ellipsis = icon(lucide.Ellipsis);
export const Eraser = icon(lucide.Eraser);
export const ExternalLink = icon(lucide.ExternalLink);
export const Eye = icon(lucide.Eye);
export const EyeOff = icon(lucide.EyeOff);
export const FilePen = icon(lucide.FilePen);
export const Flag = icon(lucide.Flag);
export const Forward = icon(lucide.Forward);
export const Gift = icon(lucide.Gift);
export const Heart = icon(lucide.Heart);
export const Highlighter = icon(lucide.Highlighter);
export const History = icon(lucide.History);
export const Home = icon(lucide.Home);
export const ImagePlus = icon(lucide.ImagePlus);
export const Info = icon(lucide.Info);
export const LayoutDashboard = icon(lucide.LayoutDashboard);
export const LayoutList = icon(lucide.LayoutList);
export const Lightbulb = icon(lucide.Lightbulb);
export const Link2 = icon(lucide.Link2);
export const ListCollapse = icon(lucide.ListCollapse);
export const LoaderCircle = icon(lucide.LoaderCircle);
export const Lock = icon(lucide.Lock);
export const LockOpen = icon(lucide.LockOpen);
export const LogOut = icon(lucide.LogOut);
export const Mail = icon(lucide.Mail);
export const Maximize = icon(lucide.Maximize);
export const Maximize2 = icon(lucide.Maximize2);
export const Menu = icon(lucide.Menu);
export const MessageCircle = icon(lucide.MessageCircle);
export const MessageSquare = icon(lucide.MessageSquare);
export const MessageSquareCode = icon(lucide.MessageSquareCode);
export const MessageSquareWarning = icon(lucide.MessageSquareWarning);
export const MessagesSquare = icon(lucide.MessagesSquare);
export const MicOff = icon(lucide.MicOff);
export const Minimize2 = icon(lucide.Minimize2);
export const Monitor = icon(lucide.Monitor);
export const Moon = icon(lucide.Moon);
export const OctagonAlert = icon(lucide.OctagonAlert);
export const PartyPopper = icon(lucide.PartyPopper);
export const PenLine = icon(lucide.PenLine);
export const PenSquare = icon(lucide.PenSquare);
export const Pencil = icon(lucide.Pencil);
export const Pin = icon(lucide.Pin);
export const PinOff = icon(lucide.PinOff);
export const Plus = icon(lucide.Plus);
export const Quote = icon(lucide.Quote);
export const Rat = icon(lucide.Rat);
export const Reply = icon(lucide.Reply);
export const Rocket = icon(lucide.Rocket);
export const ScrollText = icon(lucide.ScrollText);
export const Search = icon(lucide.Search);
export const Send = icon(lucide.Send);
export const Settings = icon(lucide.Settings);
export const Shield = icon(lucide.Shield);
export const ShieldCheck = icon(lucide.ShieldCheck);
export const Sigma = icon(lucide.Sigma);
export const Smartphone = icon(lucide.Smartphone);
export const Smile = icon(lucide.Smile);
export const Snowflake = icon(lucide.Snowflake);
export const Sparkle = icon(lucide.Sparkle);
export const Sparkles = icon(lucide.Sparkles);
export const Sun = icon(lucide.Sun);
export const Superscript = icon(lucide.Superscript);
export const Tags = icon(lucide.Tags);
export const Trash2 = icon(lucide.Trash2);
export const TrendingUp = icon(lucide.TrendingUp);
export const TriangleAlert = icon(lucide.TriangleAlert);
export const User = icon(lucide.User);
export const UserCheck = icon(lucide.UserCheck);
export const UserPlus = icon(lucide.UserPlus);
export const Users = icon(lucide.Users);
export const UsersRound = icon(lucide.UsersRound);
export const VenetianMask = icon(lucide.VenetianMask);
export const Wrench = icon(lucide.Wrench);
export const X = icon(lucide.X);
export const ZoomIn = icon(lucide.ZoomIn);
export const ZoomOut = icon(lucide.ZoomOut);
