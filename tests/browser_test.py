"""Real Firefox integration tests; temporary localhost server and browser always shut down."""
import argparse
import functools
import http.server
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--captures', required=True)
args = parser.parse_args()
root = Path(args.output)
captures = Path(args.captures)
captures.mkdir(parents=True, exist_ok=True)
board = json.loads((root / 'board.json').read_text())
by_slug = {r['slug']: r for r in board['rows']}
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
handler = functools.partial(QuietHandler, directory=str(root / 'dashboard'))
# Binding port zero atomically selects an available localhost port.
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = f'http://127.0.0.1:{server.server_port}'
errors, external, requests = [], [], []
checks = []
try:
    with sync_playwright() as p:
        browser = p.firefox.launch(headless=True)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
            page.on('pageerror', lambda e: errors.append(str(e)))
            def route_request(route):
                url = route.request.url
                requests.append(url)
                if not url.startswith(origin + '/'):
                    external.append(url)
                    route.abort()
                else:
                    route.continue_()
            page.route('**/*', route_request)
            page.goto(origin + '/index.html')
            page.wait_for_selector('html[data-ready="true"]')
            assert page.locator('#rows tr').count() == 8
            assert page.locator('[data-view="candidates"]').get_attribute('aria-pressed') == 'true'
            assert f"{board['summary']['research_candidates']} protocols" in page.locator('#results').inner_text()
            def visible_slugs():
                return page.locator('#rows tr').evaluate_all('(rows)=>rows.map(r=>r.dataset.slug)')
            for slug in visible_slugs():
                r = by_slug[slug]
                assert r['token_status'] == 'unrecorded' and not r['structural_caution']
            checks.append('default candidate coverage and board agreement')
            page.screenshot(path=str(captures / '1-board.jpg'), type='jpeg', quality=85)
            first = visible_slugs()[0]
            page.locator('#rows .protocol-button').first.focus()
            page.keyboard.press('Enter')
            assert page.locator('#detail').evaluate('(e)=>e.open')
            assert page.locator('#detail-title').inner_text() == by_slug[first]['name']
            labels = page.locator('.checklist label').all_text_contents()
            for step, label in zip(by_slug[first]['farm_steps'], labels):
                assert step in label
            page.locator('#step-0').check()
            assert page.locator('#check-progress').inner_text() == '1/5 reviewed'
            page.locator('#step-0').uncheck()
            page.screenshot(path=str(captures / '2-detail.jpg'), type='jpeg', quality=85)
            page.keyboard.press('Escape')
            assert not page.locator('#detail').evaluate('(e)=>e.open')
            assert page.evaluate('document.activeElement.classList.contains("protocol-button")')
            second = visible_slugs()[1]
            page.locator('#rows .protocol-button').nth(1).click()
            assert page.locator('#detail-title').inner_text() == by_slug[second]['name']
            assert by_slug[second]['farm_steps'][0] in page.locator('.checklist').inner_text()
            page.get_by_label('Close protocol detail').click()
            checks.append('two distinct details, exact farm steps, checklist, keyboard open/escape/focus return')
            page.locator('#search').fill(by_slug[first]['slug'])
            assert visible_slugs() == [first]
            page.locator('#search').fill('definitely-no-such-protocol')
            assert page.locator('#empty').is_visible()
            page.locator('#reset').click()
            checks.append('search and empty-state reset')
            page.locator('#category').select_option('Risk Curators')
            page.locator('#chain').select_option('Ethereum')
            page.locator('#coverage').select_option('watchlist')
            expected = [r for r in board['rows'] if r['token_status'] == 'unrecorded' and not r['structural_caution'] and r['category'] == 'Risk Curators' and 'Ethereum' in r['chains'] and r['watchlist']]
            assert len(expected) > 0
            assert f'{len(expected)} protocols' in page.locator('#results').inner_text()
            assert visible_slugs() == [r['slug'] for r in expected[:8]]
            page.screenshot(path=str(captures / '3-filtered.jpg'), type='jpeg', quality=85)
            checks.append('combined category/chain/watchlist filter against snapshot')
            page.locator('#reset').click()
            page.locator('[data-view="recorded"]').click()
            assert all(by_slug[s]['token_status'] == 'recorded' for s in visible_slugs())
            page.locator('[data-sort="tvl_usd"]').click()
            descending = visible_slugs()
            assert [by_slug[s]['tvl_usd'] for s in descending] == sorted([r['tvl_usd'] for r in board['rows'] if r['token_status'] == 'recorded'], reverse=True)[:8]
            page.locator('[data-sort="tvl_usd"]').click()
            ascending = visible_slugs()
            assert [by_slug[s]['tvl_usd'] for s in ascending] == sorted([r['tvl_usd'] for r in board['rows'] if r['token_status'] == 'recorded'])[:8]
            page.locator('#next').click()
            assert visible_slugs() != ascending
            page.locator('#prev').click()
            assert visible_slugs() == ascending
            checks.append('recorded-token separation, bidirectional numeric sorting and pagination')
            page.locator('#method-button').focus()
            page.keyboard.press('Enter')
            assert page.locator('#method').evaluate('(e)=>e.open')
            assert 'market cap' in page.locator('#method').inner_text()
            page.keyboard.press('Escape')
            assert page.evaluate('document.activeElement.id') == 'method-button'
            page.keyboard.press('/')
            assert page.evaluate('document.activeElement.id') == 'search'
            checks.append('methodology, keyboard shortcut and dialog focus')
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'page-level mobile overflow'
            assert page.locator('.table-scroll').evaluate('(e)=>e.scrollWidth > e.clientWidth')
            page.locator('#rows .protocol-button').first.click()
            assert page.locator('#detail').evaluate('(e)=>e.scrollWidth <= e.clientWidth')
            page.keyboard.press('Escape')
            checks.append('390px responsive layout and contained table overflow')
            assert not errors, errors
            assert not external, external
            checks.append('zero JavaScript errors and zero external requests')
            print(json.dumps({'status': 'PASS', 'checks': checks, 'requests': requests, 'errors': errors, 'external_requests': external}, indent=2))
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
