import { z } from "@hono/zod-openapi";

// What people call each field: messages go to members, in the page or relayed by the bot, so
// they name the field the way the form does. Fields only the plugin fills in keep their key.
const LABELS: Record<string, string> = {
  title: "标题",
  markdown: "正文",
  body: "正文",
  content: "消息",
  board: "版块",
  kind: "帖子类型",
  tags: "标签",
  name: "名称",
  description: "简介",
  slug: "地址",
  color: "颜色",
  default_kind: "默认类型",
  read_level: "阅读门槛",
  post_level: "发帖门槛",
  post_role: "发帖门槛",
  review_mode: "审核方式",
  reason: "理由",
  options: "选项",
  max_choices: "最多选几项",
  results: "结果什么时候公开",
  closes_at: "截止时间",
  prizes: "奖项",
  winners: "中奖人数",
  entry: "参与方式",
  min_level: "参与门槛",
  draws_at: "开奖时间",
  days: "天数",
  custom_name: "名字",
  custom_bio: "签名",
  shown_badge_ids: "展示徽章",
  theme: "主题色",
  background: "背景",
  frame: "头像框",
  pins: "代表作",
  showcase: "展柜",
  bio: "简介",
  banner: "公告横幅",
  code_hint: "口令说明",
  code: "验证码",
  qq: "QQ 号",
  email: "邮箱",
  host: "服务器",
  port: "端口",
  user: "用户名",
  password: "密码",
  url: "图片地址",
  file: "图片",
  q: "搜索词",
  text: "文字",
  emoji: "表情",
  level: "等级",
  role: "角色",
  group_id: "群号",
  bot_qq: "bot 的 QQ 号",
  scopes: "权限",
  seconds: "时长",
  reply_to_id: "回复的楼层",
  visibility: "可见范围",
  amount: "金额",
  message: "留言",
  method: "付款方式",
  paid_at: "付款时间",
  payee: "收款人",
  wechat: "微信收款码",
  alipay: "支付宝收款码",
};

// Zod's own Chinese messages read like a compiler ("数值过小：期望 string >=4 字符"); these are
// sentences. Messages a schema gives itself win over this map.
export const describeIssue: z.core.$ZodErrorMap = (issue) => {
  const key = issue.path?.findLast((part) => typeof part === "string");
  const label = key === undefined ? "请求" : (LABELS[key] ?? `「${key}」`);
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string") {
        return issue.minimum === 1 ? `请填写${label}` : `${label}至少 ${issue.minimum} 个字`;
      }
      if (issue.origin === "array") return `${label}至少需要 ${issue.minimum} 个`;
      return `${label}不能小于 ${issue.minimum}`;
    case "too_big":
      if (issue.origin === "string") return `${label}最多 ${issue.maximum} 个字`;
      if (issue.origin === "array") return `${label}最多 ${issue.maximum} 个`;
      return `${label}不能大于 ${issue.maximum}`;
    case "invalid_type":
      return issue.input === undefined ? `缺少${label}` : `${label}的格式不正确`;
    case "invalid_value":
      return `${label}不在可选范围内`;
    case "invalid_format":
    case "invalid_union":
      return `${label}的格式不正确`;
    case "custom":
    case "invalid_element":
    case "invalid_key":
    case "not_multiple_of":
    case "unrecognized_keys":
      break;
  }
  // Zod's own message.
  return undefined;
};
