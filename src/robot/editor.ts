const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Presentation only: execution always reads the textarea's original source. */
export function highlightedCode(source: string): string {
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|\b(?:const|void|int|float|long|bool|unsigned|if|else|return)\b|\b(?:HIGH|LOW|OUTPUT|INPUT)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*(?=\()/g;
  let result = "", start = 0;
  for (const match of source.matchAll(pattern)) {
    result += escape(source.slice(start, match.index)); const text = match[0];
    const kind = text.startsWith("//") || text.startsWith("/*") ? "comment" : text.startsWith('"') ? "string" : /^(const|void|int|float|long|bool|unsigned|if|else|return)$/.test(text) ? "keyword" : /^\d/.test(text) || /^(HIGH|LOW|OUTPUT|INPUT)$/.test(text) ? "number" : "function";
    result += `<span class="syntax-${kind}">${escape(text)}</span>`; start = match.index! + text.length;
  }
  return result + escape(source.slice(start)) + "\n";
}
export class SketchEditor {
  constructor(private input: HTMLTextAreaElement, private syntax: HTMLElement, private gutter: HTMLElement) {
    input.addEventListener("input", () => this.refresh());
    input.addEventListener("scroll", () => { syntax.scrollTop = input.scrollTop; syntax.scrollLeft = input.scrollLeft; gutter.scrollTop = input.scrollTop; });
    this.refresh();
  }
  refresh(): void { this.syntax.innerHTML = highlightedCode(this.input.value); this.gutter.textContent = Array.from({ length: this.input.value.split("\n").length }, (_, i) => String(i + 1)).join("\n"); this.syntax.scrollTop = this.input.scrollTop; this.syntax.scrollLeft = this.input.scrollLeft; }
}
