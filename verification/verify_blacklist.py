
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('http://localhost:8084')
        page.wait_for_timeout(2000)

        # Handle Age Gate
        if page.locator('#age-gate-modal').is_visible():
            page.click('#age-gate-enter')
            page.wait_for_timeout(1000)

        # 1. Go to products page
        page.goto('http://localhost:8084/#/products')
        page.wait_for_timeout(2000)

        # Check Filters - ideally we would simulate product data to trigger the blacklist,
        # but for now we just verify the page loads and filters render (even if empty).
        page.screenshot(path='verification/filter_blacklist_check.png')

        browser.close()

if __name__ == '__main__':
    run()
