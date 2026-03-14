from playwright.sync_api import sync_playwright

def verify_changes():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        page = context.new_page()

        # Go to products page directly
        page.goto("http://localhost:8080/#/products")
        page.wait_for_timeout(3000)

        # Click Age Gate (Tenho 18+ anos)
        try:
            page.get_by_role("button", name="Tenho 18+ anos").click(timeout=5000)
            page.wait_for_timeout(2000)
        except Exception as e:
            print("Age gate not found or already bypassed:", e)

        # Open the filters accordion to see the categories/subcategories filter
        try:
            page.locator(".accordion-header").click(timeout=5000)
            page.wait_for_timeout(1000)
            page.screenshot(path="products_open_filters_screenshot.png")
        except Exception as e:
            print("Could not click filters accordion:", e)

        browser.close()

if __name__ == "__main__":
    verify_changes()