"""Audit existing MHTML URL evidence offline, without resolving redirects."""
import argparse
from collections import Counter
from email import policy
from email.parser import BytesParser
import json
from pathlib import Path
from urllib.parse import urlsplit

from inspect_mhtml import Tree, clean, decode_text


def audit(path):
    message = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
    parts = [p for p in message.walk() if p.get_content_type() == 'text/html']
    snapshot = message.get('Snapshot-Content-Location')
    main = next((p for p in parts if p.get('Content-Location') == snapshot), parts[0])
    tree = Tree()
    tree.feed(decode_text(main))
    results = []
    for heading in (n for n in tree.root.walk() if n.tag == 'h3'):
        anchor = heading.parent
        while anchor and anchor.tag != 'a':
            anchor = anchor.parent
        if anchor is None:
            continue
        block = anchor
        # Keep evidence within a block with exactly one heading.
        for _ in range(10):
            if not block.parent or sum(n.tag == 'h3' for n in block.parent.walk()) != 1:
                break
            block = block.parent
        displayed = []
        candidates = []
        for node in block.walk():
            value = clean(node.text()) if node.tag == 'cite' else ''
            if value.startswith(('https://', 'http://')) and value not in displayed:
                displayed.append(value)
            for key, value in node.attrs.items():
                if key not in {'data-curl', 'data-surl', 'data-href', 'data-url', 'href'} or not value:
                    continue
                parsed = urlsplit(value)
                host = parsed.hostname or ''
                if parsed.scheme not in {'http', 'https'} or host in {'www.google.com', 'www.google.co.jp'} or host.endswith(('.gstatic.com', '.googleusercontent.com')):
                    continue
                item = {'attribute': key, 'url': value}
                if item not in candidates:
                    candidates.append(item)
        results.append({'title': clean(heading.text()), 'displayed_breadcrumbs': displayed,
                        'explicit_url_candidates': candidates,
                        'candidate_status': 'unverified_block_attribute' if candidates else 'no_explicit_target_found',
                        'note': 'Breadcrumbs are not complete article URLs; block attributes are candidates, not verified destinations.'})
    content_types = Counter(p.get_content_type() for p in message.walk() if not p.is_multipart())
    return {'input': path.name, 'network_requests': 0, 'mime_content_types': dict(content_types),
            'html_script_elements': sum(decode_text(p).lower().count('<script') for p in parts),
            'results': results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mhtml', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    report = audit(args.mhtml)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'results': len(report['results']), 'with_explicit_candidates': sum(bool(r['explicit_url_candidates']) for r in report['results']), 'network_requests': 0}))
