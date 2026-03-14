from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})

    print("Navigating to products page...")
    page.goto("http://localhost:8000/#/products")
    time.sleep(2)

    print("Handling age gate if present...")
    try:
        age_btn = page.get_by_role("button", name="TENHO 18+ ANOS")
        if age_btn.is_visible(timeout=3000):
            age_btn.click()
            time.sleep(1)
    except Exception as e:
        print("No age gate found or clicked")

    print("Opening filter menu...")
    # The button is `.accordion-header`
    filter_btn = page.locator(".accordion-header").first
    if filter_btn.is_visible():
        filter_btn.click()
        time.sleep(1)

    # Hide the cookie banner to make sure we see everything
    try:
        page.evaluate("document.querySelector('#cookie-consent').style.display = 'none'")
    except:
        pass

    print("Taking screenshot of products page with filters open...")
    page.screenshot(path="filters_desktop_open.png")

    browser.close()
    print("Verification complete.")
