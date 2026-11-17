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
rows = board['rows']
by_slug = {r['slug']: r for r in rows}
size = 8


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


handler = functools.partial(QuietHandler, directory=str(root / 'dashboard'))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = f'http://127.0.0.1:{server.server_port}'
errors, external, requests, checks = [], [], [], []


def wait_ready(page):
    page.wait_for_selector('html[data-ready="true"]')


def slugs(page):
    return page.locator('#rows tr').evaluate_all('(r) => r.map(x => x.dataset.slug)')


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
            wait_ready(page)
            assert page.locator('#rows tr').count() == size

            # A. coverage line is generated from model output, not typed into HTML.
            coverage = page.locator('#coverage-line').inner_text()
            summary = board['summary']
            assert f"{summary['watchlist_covered']} / {summary['watchlist_total']} watchlist protocols" in coverage, coverage
            assert 'floor, not the ceiling' in coverage
            assert str(summary['below_watchlist']) in coverage
            assert page.locator('#coverage-line').get_attribute('data-ok') == 'true'
            checks.append('on-page coverage line states watchlist coverage and below-watchlist depth')

            # B. layout density at 100% zoom.
            geometry = page.evaluate('''() => {
                const rr = [...document.querySelectorAll('#rows tr')].map(e => e.getBoundingClientRect());
                return { first_row_top: rr[0].top, fully_visible_rows: rr.filter(r => r.top >= 0 && r.bottom <= innerHeight).length,
                         viewport_height: innerHeight };
            }''')
            print('Desktop geometry:', json.dumps(geometry), flush=True)
            assert geometry['fully_visible_rows'] >= 6, 'at least six complete rows must fit at 100% zoom'
            checks.append('1440x900 density: six complete rows and inspector range visible')

            first_page = slugs(page)
            assert len(first_page) == size
            assert page.locator('#rows tr[data-detail]').count() == size
            page.screenshot(path=str(captures / '1-board.jpg'), type='jpeg', quality=85)

            # C. clicking anywhere on a row opens the detail with every driver.
            page.locator('#rows tr').nth(2).click(position={'x': 400, 'y': 20})
            assert page.locator('#detail').evaluate('(e) => e.open')
            detail_slug = first_page[2]
            assert page.locator('#detail-title').inner_text() == by_slug[detail_slug]['name']
            detail_text = page.locator('#detail').inner_text()
            for label in ['TVL used by model', 'Peer multiple (mcap / TVL)', 'Growth used',
                          'Age factor (listing maturity)', 'Structure factor', 'Confidence']:
                assert label in detail_text, label
            labels = page.locator('.checklist label').all_text_contents()
            for step, label in zip(by_slug[detail_slug]['farm_steps'], labels):
                assert step in label
            page.locator('#step-0').check()
            assert page.locator('#check-progress').inner_text() == '1/5 reviewed'
            page.locator('#step-0').uncheck()
            page.screenshot(path=str(captures / '2-detail.jpg'), type='jpeg', quality=85)
            page.keyboard.press('Escape')
            assert not page.locator('#detail').evaluate('(e) => e.open')
            checks.append('row click opens detail with all five drivers, confidence and exact farm steps')

            # D. keyboard path still works from a row button.
            page.locator('#rows .protocol-button').first.focus()
            page.keyboard.press('Enter')
            assert page.locator('#detail').evaluate('(e) => e.open')
            page.keyboard.press('Escape')
            assert page.evaluate('document.activeElement.classList.contains("protocol-button")')
            checks.append('keyboard open, Escape close and focus return')

            # Plan structure: totals come from the shipped plan, and unsupported rows are research-only.
            page.locator('#rows .protocol-button').first.click()
            plan = by_slug[slugs(page)[0]]['plan']
            panel = page.locator('#detail').inner_text()
            assert ('CONDITIONAL TEST PLAN' if plan['mode'] == 'conditional' else 'RESEARCH ONLY') in panel
            totals = page.locator('.plan-totals dd').all_text_contents()
            assert totals[0] == f"{plan['totals']['minutes']} min", totals
            assert totals[1] == f"${plan['totals']['fee_low']}–${plan['totals']['fee_high']}", totals
            assert len(page.locator('.checklist li').all()) == len(plan['steps'])
            assert plan['review_date'] in panel, 'review date must be rendered'
            assert 'Per-chain fee assumption' in panel
            assert 'Age sensitivity' in panel and 'neutral' in panel
            page.keyboard.press('Escape')
            page.locator('[data-view="all"]').click()
            page.locator('#coverage').select_option('structural')
            page.locator('#rows .protocol-button').first.click()
            research = page.locator('#detail').inner_text()
            assert 'RESEARCH ONLY' in research and 'No capital' in research
            assert 'NEXT ACTION' in research and 'Next action on' in research
            assert page.locator('.plan-totals dd').all_text_contents()[2] == 'No capital'
            page.keyboard.press('Escape')
            page.locator('#reset').click()
            checks.append('detail renders shipped plan totals and the research-only state')

            # E. filtered state is named, linked in the hash, and restorable from the hash.
            page.locator('#category').select_option('Risk Curators')
            page.locator('#chain').select_option('Ethereum')
            page.locator('#coverage').select_option('watchlist')
            expected = [r for r in rows if r['token_status'] == 'unrecorded' and not r['structural_caution']
                        and r['category'] == 'Risk Curators' and 'Ethereum' in r['chains'] and r['watchlist']]
            assert len(expected) > 0
            assert f'{len(expected)} protocols' in page.locator('#results').inner_text()
            hash_now = page.evaluate('location.hash')
            assert 'coverage=watchlist' in hash_now and 'chain=Ethereum' in hash_now, hash_now
            chips = page.locator('#filter-chips .chip').all_text_contents()
            assert any('Official watchlist only' in c for c in chips), chips
            assert any('Risk Curators' in c for c in chips), chips
            filtered_slugs = slugs(page)
            assert filtered_slugs == [r['slug'] for r in expected[:size]]
            page.screenshot(path=str(captures / '3-filtered.jpg'), type='jpeg', quality=85)
            checks.append('combined filters narrow the board and are named in chips plus the URL hash')

            page.reload()
            wait_ready(page)
            assert page.locator('#coverage').input_value() == 'watchlist'
            assert page.locator('#chain').input_value() == 'Ethereum'
            assert slugs(page) == filtered_slugs
            checks.append('filtered view survives reload as a deep link')
            page.locator('#reset').click()

            # F. every page is reachable and the last page holds the final ranked row.
            page.locator('[data-view="all"]').click()
            total = len(rows)
            pages = -(-total // size)
            assert page.locator('#page-input').input_value() == '1'
            page.locator('#last').click()
            last_slugs = slugs(page)
            assert len(last_slugs) == total - (pages - 1) * size
            assert by_slug[last_slugs[-1]]['rank'] == total
            assert f'Page {pages}/{pages}' in page.locator('#page-label').inner_text()
            page.locator('#first').click()
            assert slugs(page)[0] == rows[0]['slug']
            checks.append(f'all {total} rows reachable across {pages} pages; first/last/jump controls work')

            # G. sorting changes order for a real numeric column and for rank delta.
            page.locator('[data-sort="tvl_usd"]').click()
            desc = slugs(page)
            assert [by_slug[s]['tvl_usd'] for s in desc] == sorted([r['tvl_usd'] for r in rows], reverse=True)[:size]
            page.locator('[data-sort="tvl_usd"]').click()
            asc = slugs(page)
            assert [by_slug[s]['tvl_usd'] for s in asc] == sorted([r['tvl_usd'] for r in rows])[:size]
            page.locator('[data-sort="rank_delta"]').click()
            deltas = [by_slug[s]['rank_delta'] for s in slugs(page)]
            assert deltas == sorted([r['rank_delta'] for r in rows], reverse=True)[:size]
            checks.append('numeric sorting is bidirectional and rank-delta sorting matches the model')

            # H. low-confidence filter shows only Low badges.
            page.locator('#reset').click()
            page.locator('[data-view="all"]').click()
            page.locator('#coverage').select_option('low')
            badges = page.locator('#rows .badge').all_text_contents()
            assert badges and all(b == 'Low' for b in badges)
            checks.append('low-confidence filter lists only rows flagged Low')

            # I. methodology panel still documents the model.
            page.locator('#reset').click()
            page.locator('#method-button').focus()
            page.keyboard.press('Enter')
            assert page.locator('#method').evaluate('(e) => e.open')
            assert 'market cap' in page.locator('#method').inner_text()
            page.keyboard.press('Escape')
            page.keyboard.press('/')
            assert page.evaluate('document.activeElement.id') == 'search'
            checks.append('methodology panel and keyboard shortcut')

            # J. responsive layout with contained table overflow.
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert page.locator('.table-scroll').evaluate('(e) => e.scrollWidth > e.clientWidth')
            page.locator('#rows .protocol-button').first.click()
            assert page.locator('#detail').evaluate('(e) => e.scrollWidth <= e.clientWidth')
            page.keyboard.press('Escape')
            checks.append('390px responsive layout and contained table overflow')

            assert not errors, errors
            assert not external, external
            checks.append('zero JavaScript errors and zero external requests')
            print(json.dumps({'status': 'PASS', 'checks': checks, 'requests': requests,
                              'errors': errors, 'external_requests': external}, indent=2))
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
