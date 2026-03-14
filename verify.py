from playwright.sync_api import sync_playwright

def verify_changes():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        page = context.new_page()

        # Go to home page
        page.goto("http://localhost:8080/#/")
        page.wait_for_timeout(3000)

        # Click Age Gate (Tenho 18+ anos)
        try:
            page.get_by_role("button", name="Tenho 18+ anos").click(timeout=5000)
            page.wait_for_timeout(2000)
        except Exception as e:
            print("Age gate not found or already bypassed:", e)

        # Take screenshot of home page (hero section) to verify image cropping
        page.screenshot(path="hero_screenshot.png")

        # Open search overlay
        try:
            page.locator("#search-icon").click(timeout=5000)
            page.wait_for_timeout(2000)
            # Take screenshot of search overlay to verify "Sub-categoria"
            page.screenshot(path="search_overlay_screenshot.png")
            page.locator("#close-search-btn").click(timeout=5000)
            page.wait_for_timeout(1000)
        except Exception as e:
            print("Could not open search overlay:", e)

        # Go to products page
        page.goto("http://localhost:8080/#/products")
        page.wait_for_timeout(3000)

        # Take screenshot of products page filters
        page.screenshot(path="products_filters_screenshot.png")

        browser.close()

if __name__ == "__main__":
    verify_changes()