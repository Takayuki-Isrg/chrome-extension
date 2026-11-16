"""Synthetic fixtures only: not evidence of real Google capture accuracy."""
from email.message import EmailMessage
from pathlib import Path
import tempfile
import unittest
from inspect_mhtml import inspect


class ReaderTest(unittest.TestCase):
    def test_opaque_google_link_is_not_article_url(self):
        from inspect_mhtml import extract
        _, results = extract('<a href="/goto?url=opaque"><h3>候補</h3></a>', 'https://www.google.com/search?q=test')
        self.assertIsNone(results[0]['url'])
        self.assertEqual(results[0]['url_status'], 'unresolved_google_link')

    def test_html_meta_charset_without_mime_charset(self):
        with tempfile.TemporaryDirectory() as folder:
            msg = EmailMessage()
            msg.set_content('<meta charset="UTF-8"><a href="https://example.org"><h3>日本語タイトル</h3></a>', subtype='html', charset='utf-8', cte='quoted-printable')
            msg.replace_header('Content-Type', 'text/html')
            path = Path(folder) / 'capture.txt'
            path.write_bytes(msg.as_bytes())
            text, report = inspect(path)
            self.assertIn('日本語タイトル', text)
            self.assertGreater(report['japanese_characters'], 0)
            self.assertEqual(report['risk_indicator_counts']['replacement_character'], 0)

    def test_mime_encodings_and_missing_snippet(self):
        for charset, cte in [('utf-8', 'quoted-printable'), ('utf-8', 'base64'), ('iso-2022-jp', 'base64')]:
            with self.subTest(charset=charset, cte=cte), tempfile.TemporaryDirectory() as folder:
                msg = EmailMessage()
                msg['Snapshot-Content-Location'] = 'https://www.google.com/search?q=test'
                msg.make_related()
                html = EmailMessage()
                html.set_content('<div><a href="https://example.org/"><h3>日本語の公開案内</h3></a><div class="VwiC3b">説明文です。</div></div><div><a href="https://example.net/"><h3>説明なし</h3></a></div><script>SECRET_SCRIPT</script>', subtype='html', charset=charset, cte=cte)
                html['Content-Location'] = msg['Snapshot-Content-Location']
                msg.attach(html)
                path = Path(folder) / 'synthetic.mhtml'
                path.write_bytes(msg.as_bytes())
                text, report = inspect(path)
                self.assertIn('日本語の公開案内', text)
                self.assertNotIn('SECRET_SCRIPT', text)
                self.assertEqual(report['candidate_count'], 2)
                self.assertEqual(report['missing_snippets'], 1)
                self.assertEqual(report['results'][0]['snippet'], '説明文です。')
                self.assertEqual(report['results'][0]['url'], 'https://example.org/')


if __name__ == '__main__':
    unittest.main()
