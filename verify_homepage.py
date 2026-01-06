from playwright.sync_api import sync_playwright

def verify_homepage():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        page.on("console", lambda msg: print(f"CONSOLE: {msg.text}"))
        page.on("pageerror", lambda err: print(f"PAGE ERROR: {err}"))
        # page.on("requestfailed", lambda req: print(f"REQUEST FAILED: {req.url} {req.failure}"))

        # Go to the app (guest user)
        page.goto("http://localhost:8080/")

        # Check for Age Gate and click it if present
        try:
            page.wait_for_selector("#age-gate-enter", timeout=5000)
            page.click("#age-gate-enter")
            print("Clicked Age Gate.")
            page.wait_for_timeout(5000)
        except Exception as e:
            print(f"Age Gate not found or already bypassed: {e}")

        try:
            slide = page.locator(".hero-slide[data-slide-index='0'] .bg-cover")
            style = slide.get_attribute("style")
            print(f"Slide 0 Style: {style}")
        except:
            print("Could not find slide 0")

        # Take screenshot
        page.screenshot(path="verification_homepage.png")
        print("Homepage screenshot taken.")

        browser.close()

if __name__ == "__main__":
    verify_homepage()
