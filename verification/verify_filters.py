
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('http://localhost:8083')
        page.wait_for_timeout(2000)

        # Handle Age Gate
        if page.locator('#age-gate-modal').is_visible():
            page.click('#age-gate-enter')
            page.wait_for_timeout(1000)

        # 1. Go to products page
        page.goto('http://localhost:8083/#/products')
        page.wait_for_timeout(2000)

        # Open Filters Accordion if closed (it is open by default in template, but check)
        # Check Filters
        page.screenshot(path='verification/filters_check.png')

        browser.close()

if __name__ == '__main__':
    run()
