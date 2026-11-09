// Turns model output into text Alexa can speak safely inside <speak> tags.

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toSpeech(text, maxChars = 1200) {
  let s = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) → label
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}(#{1,6}|[-*+>]|\d+[.)])\s+/gm, "")
    .replace(/[*_`~|#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    s = end > maxChars / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return escapeXml(s);
}
