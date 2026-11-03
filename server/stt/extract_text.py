"""Pull readable text out of a document the harness already stored.

Plain text is read as UTF-8. PDF uses pypdf. Office files are ZIP packages;
this only keeps their visible XML text and drops the markup.
"""

import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

LIMIT = 80_000


def clip(text):
    text = text.replace("\x00", "").strip()
    if len(text) <= LIMIT:
        return text
    return text[:LIMIT].rstrip() + "\n（以下省略）"


def plain(path):
    return Path(path).read_text(encoding="utf-8", errors="replace")


def pdf(path):
    from pypdf import PdfReader

    reader = PdfReader(path)
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def xml_text(blob):
    try:
        root = ElementTree.fromstring(blob)
    except ElementTree.ParseError:
        return ""
    parts = []
    for node in root.iter():
        if node.text and node.text.strip():
            parts.append(node.text.strip())
        if node.tail and node.tail.strip():
            parts.append(node.tail.strip())
    return "\n".join(parts)


def office(path, members):
    chunks = []
    with zipfile.ZipFile(path) as package:
        names = [name for name in package.namelist() if any(name.startswith(prefix) for prefix in members)]
        for name in sorted(names):
            chunks.append(xml_text(package.read(name)))
    return "\n".join(chunk for chunk in chunks if chunk)


def main():
    path = Path(sys.argv[1])
    ext = path.suffix.lower()
    if ext in {".txt", ".md", ".csv", ".tsv", ".json"}:
        text = plain(path)
    elif ext == ".pdf":
        text = pdf(path)
    elif ext == ".docx":
        text = office(path, ("word/document.xml",))
    elif ext == ".xlsx":
        text = office(path, ("xl/sharedStrings.xml", "xl/worksheets/"))
    elif ext == ".pptx":
        text = office(path, ("ppt/slides/",))
    elif ext == ".odt":
        text = office(path, ("content.xml",))
    else:
        sys.exit(f"unsupported document: {ext}")
    sys.stdout.write(clip(text))


if __name__ == "__main__":
    main()
