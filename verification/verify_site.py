from playwright.sync_api import sync_playwright

def verify_ui():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # Desktop Context (1920x1080)
        desktop_context = browser.new_context(viewport={"width": 1920, "height": 1080})
        desktop_page = desktop_context.new_page()

        # Mobile Context (iPhone X - 375x812)
        mobile_context = browser.new_context(
            viewport={"width": 375, "height": 812},
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1"
        )
        mobile_page = mobile_context.new_page()

        try:
            # 1. Homepage
            print("Visiting Homepage...")
            # Use domcontentloaded instead of networkidle because Firebase might keep connections open
            desktop_page.goto("http://localhost:8080/index.html", wait_until="domcontentloaded")
            desktop_page.wait_for_timeout(5000) # Give 5 seconds for JS to render
            desktop_page.screenshot(path="verification/desktop_home.png", full_page=True)

            mobile_page.goto("http://localhost:8080/index.html", wait_until="domcontentloaded")
            mobile_page.wait_for_timeout(5000)
            mobile_page.screenshot(path="verification/mobile_home.png", full_page=True)

            # 2. Cart
            print("Visiting Cart...")
            desktop_page.goto("http://localhost:8080/index.html#/cart", wait_until="domcontentloaded")
            desktop_page.wait_for_timeout(3000)
            desktop_page.screenshot(path="verification/desktop_cart.png")

            mobile_page.goto("http://localhost:8080/index.html#/cart", wait_until="domcontentloaded")
            mobile_page.wait_for_timeout(3000)
            mobile_page.screenshot(path="verification/mobile_cart.png")

            # 3. Account
            print("Visiting Account...")
            desktop_page.goto("http://localhost:8080/index.html#/account", wait_until="domcontentloaded")
            desktop_page.wait_for_timeout(3000)
            desktop_page.screenshot(path="verification/desktop_account.png")

        except Exception as e:
            print(f"Error: {e}")
        finally:
            browser.close()

if __name__ == "__main__":
    verify_ui()
