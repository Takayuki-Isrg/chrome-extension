"""Offline-only exploratory MHTML reader. No network or script execution."""
import argparse
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urljoin, urlsplit, parse_qs


class Node:
    def __init__(self, tag='', attrs=(), parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def text(self):
        if self.tag in {'script', 'style', 'noscript', 'template', 'svg'}:
            return ''
        return ' '.join(c.text() if isinstance(c, Node) else c for c in self.children)


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.current = Node()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        node = self.current
        while node.parent:
            if node.tag == tag:
                self.current = node.parent
                return
            node = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


def clean(value):
    return re.sub(r'\s+', ' ', value).strip()


def decode_text(part):
    """Chrome HTML MIME parts may omit charset but declare it in HTML."""
    data = part.get_payload(decode=True)
    charset = part.get_content_charset()
    if not charset and part.get_content_type() == 'text/html':
        match = re.search(rb'<meta\b[^>]*charset\s*=\s*[\"\x27]?\s*([A-Za-z0-9._-]+)', data[:8192], re.I)
        if match:
            charset = match.group(1).decode('ascii')
    # Strict decoding: never silently replace Japanese with U+FFFD.
    return data.decode(charset or 'utf-8', errors='strict')


def extract(html, base):
    tree = Tree()
    tree.feed(html)
    results = []
    for heading in (n for n in tree.root.walk() if n.tag == 'h3'):
        anchor = heading.parent
        while anchor and anchor.tag != 'a':
            anchor = anchor.parent
        if not anchor:
            continue
        raw = anchor.attrs.get('href', '')
        url = urljoin(base, raw)
        observed_url = url
        parsed = urlsplit(url)
        if parsed.hostname in {'www.google.com', 'www.google.co.jp'} and parsed.path == '/url':
            url = (parse_qs(parsed.query).get('q') or parse_qs(parsed.query).get('url') or [url])[0]
        if urlsplit(url).scheme not in {'http', 'https'}:
            continue
        unresolved = urlsplit(url).hostname in {'www.google.com', 'www.google.co.jp'}
        if unresolved:
            # /goto?url=<opaque token> is not the article's source URL.
            # Do not follow it or infer/decode an undocumented target.
            url = None
        # Experimental known snippet classes, bounded to a single-heading ancestor.
        snippets = []
        block = anchor.parent
        for _ in range(6):
            if not block:
                break
            nodes = list(block.walk())
            if sum(n.tag == 'h3' for n in nodes) != 1:
                break
            snippets = [clean(n.text()) for n in nodes if set(n.attrs.get('class', '').split()) & {'VwiC3b', 'IsZvec', 'aCOpRe'}]
            if snippets:
                break
            block = block.parent
        results.append({'title': clean(heading.text()), 'url': url, 'raw_href': raw,
                        'observed_link_url': observed_url,
                        'url_status': 'unresolved_google_link' if unresolved else 'external_url_present',
                        'snippet': snippets[0] if snippets else None,
                        'classification': 'unverified_heading_link_candidate',
                        'publication_date': None})
    return clean(tree.root.text()), results


def inspect(path):
    raw = path.read_bytes()
    message = BytesParser(policy=policy.default).parsebytes(raw)
    parts = [p for p in message.walk() if p.get_content_type() == 'text/html']
    if not parts:
        raise ValueError('MHTMLにtext/htmlパートがありません')
    # Prefer the part whose Content-Location matches Snapshot-Content-Location.
    snapshot = str(message.get('Snapshot-Content-Location', ''))
    main = next((p for p in parts if p.get('Content-Location') == snapshot), parts[0])
    base = str(main.get('Content-Location', snapshot))
    html = decode_text(main)
    text, results = extract(html, base)
    decoded = '\n'.join(decode_text(p) for p in message.walk() if p.get_content_maintype() == 'text')
    # Only counts are reported: never print suspected secrets.
    patterns = {'email_like': r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}',
                'cookie_header_like': r'(?im)^(?:set-cookie|cookie)\s*:',
                'authorization_header_like': r'(?im)^authorization\s*:',
                'token_marker': r'(?i)\b(?:access_token|id_token|sessionid|SID|SAPISID)\b',
                'password_input': r'(?i)type\s*=\s*[\"\x27]?password',
                'replacement_character': '\ufffd'}
    report = {'input': path.name, 'source_url': base, 'html_parts': len(parts),
              'mime_defects': [type(d).__name__ for p in message.walk() for d in p.defects],
              'text_characters': len(text), 'japanese_characters': len(re.findall(r'[ぁ-んァ-ヶ一-龯]', text)),
              'candidate_count': len(results), 'missing_snippets': sum(r['snippet'] is None for r in results),
              'unresolved_urls': sum(r['url'] is None for r in results),
              'risk_indicator_counts': {k: len(re.findall(v, decoded)) for k, v in patterns.items()},
              'limitations': ['Heuristic candidates are not verified organic results.',
                              'No article bodies, identity verification or reliable publication dates.',
                              'Risk indicators do not certify absence of personal data or secrets.'],
              'results': results}
    return text, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mhtml', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        text, report = inspect(args.mhtml)
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / 'text.txt').write_text(text, encoding='utf-8')
        (args.out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({k: v for k, v in report.items() if k not in {'results', 'source_url'}}, ensure_ascii=False, indent=2))
    except (OSError, ValueError, LookupError) as exc:
        parser.exit(1, f'読み込み失敗: {exc}\n')


if __name__ == '__main__':
    main()
