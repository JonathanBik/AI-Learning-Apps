#!/usr/bin/env python3
"""Inline css/ and js/ into a single self-contained HTML file.

    python3 bundle.py                      -> dist/llm-inference-mastery.html (full document)
    python3 bundle.py --fragment OUT.html  -> body-only fragment (no doctype/html/head/body tags),
                                              for hosts that wrap the page in their own skeleton
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent


def inline(html: str) -> str:
    def css(m):
        return "<style>\n" + (ROOT / m.group(1)).read_text() + "\n</style>"

    def js(m):
        src = (ROOT / m.group(1)).read_text().replace("</script", "<\\/script")
        return "<script>\n" + src + "\n</script>"

    html = re.sub(r'<link rel="stylesheet" href="(css/[^"]+)">', css, html)
    html = re.sub(r'<script src="(js/[^"]+)"></script>', js, html)
    return html


def fragment(html: str) -> str:
    head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    head = re.sub(r"<meta (charset|name=\"viewport\")[^>]*>\n?", "", head)
    return head.strip() + "\n" + body.strip() + "\n"


def main():
    html = inline((ROOT / "index.html").read_text())
    if len(sys.argv) >= 3 and sys.argv[1] == "--fragment":
        out = pathlib.Path(sys.argv[2])
        out.write_text(fragment(html))
    else:
        out = ROOT / "dist" / "llm-inference-mastery.html"
        out.parent.mkdir(exist_ok=True)
        out.write_text(html)
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
