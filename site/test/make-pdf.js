/** A hand-rolled PDF writer, just enough to feed pdf.js a known page.
 *
 * Fixtures are built rather than committed so the geometry under test is
 * visible in the test itself: every run says where it sits and how big it is.
 * Courier is the only font because its advance is exactly 0.6em per character,
 * so a run can be placed flush against its neighbour ("19" then "87") with no
 * font metrics to look up.
 */
export const CHAR_W = 0.6;

/** Width of `text` set in Courier at `size`, in PDF points. */
export function textWidth(text, size) {
  return text.length * CHAR_W * size;
}

function escape(text) {
  return text.replace(/([\\()])/g, "\\$1");
}

/** Build a one-object-per-line PDF from pages of positioned text runs.
 *
 * Each page is `{ width, height, runs }`; each run is `{ text, x, y, size }`
 * with `y` measured down from the top of the page, like PyMuPDF's insert_text,
 * so these fixtures read like their Python counterparts.
 */
export function makePdf(pages) {
  const objects = [];
  // Object 1 is the page tree, prepended at the end, so the nth pushed object
  // is object n + 1.
  const add = body => objects.push(body) + 1;
  // Two identical Courier resources: pdf.js starts a new text item whenever the
  // font resource changes, which is how a real PDF ends up handing us "19" and
  // "87" as two items. Runs say `font: 2` to force that split.
  const fonts = [1, 2].map(() => add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"));
  const kids = [];
  for (const page of pages) {
    const { width = 612, height = 792 } = page;
    const stream = page.runs.map(({ text, x, y, size = 10, font = 1 }) => (
      `BT /F${font} ${size} Tf 1 0 0 1 ${x} ${height - y} Tm (${escape(text)}) Tj ET`
    )).join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(
      `<< /Type /Page /Parent 1 0 R /MediaBox [0 0 ${width} ${height}]`
      + ` /Resources << /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R >> >>`
      + ` /Contents ${content} 0 R >>`,
    ));
  }
  // The page tree is object 1 and the catalog is last, so kids are known by now.
  const tree = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}]`
    + ` /Count ${kids.length} >>`;
  const root = add("<< /Type /Catalog /Pages 1 0 R >>");
  const bodies = [tree, ...objects];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  bodies.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${bodies.length + 1} /Root ${root} 0 R >>\n`
    + `startxref\n${startxref}\n%%EOF\n`;
  return new Uint8Array([...pdf].map(c => c.charCodeAt(0)));
}
