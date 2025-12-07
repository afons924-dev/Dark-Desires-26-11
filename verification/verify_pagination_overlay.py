
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('http://localhost:8082')
        page.wait_for_timeout(2000)

        # Handle Age Gate
        if page.locator('#age-gate-modal').is_visible():
            page.click('#age-gate-enter')
            page.wait_for_timeout(1000)

        # 1. Verify Grid - Products page
        page.goto('http://localhost:8082/#/products')
        page.wait_for_timeout(3000)
        page.screenshot(path='verification/products_grid_16_items.png')

        # 2. Verify Search Overlay Top Positioning
        page.click('#search-icon')
        page.wait_for_timeout(1000)
        page.screenshot(path='verification/search_overlay_top.png')

        browser.close()

if __name__ == '__main__':
    run()
