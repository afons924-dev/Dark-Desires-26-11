from playwright.sync_api import sync_playwright

def verify_coming_soon():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Go to the app (guest user)
        page.goto("http://localhost:8080/")

        # Check for Age Gate and click it if present
        try:
            page.wait_for_selector("#age-gate-enter", timeout=5000)
            page.click("#age-gate-enter")
            print("Clicked Age Gate.")
            page.wait_for_timeout(2000) # Wait for fade out and re-render
        except Exception as e:
            print(f"Age Gate not found or already bypassed: {e}")

        # Check for text "Em Desenvolvimento" or "Acesso Restrito"
        try:
            page.wait_for_selector("text=Em Desenvolvimento", timeout=5000)
            print("Found 'Em Desenvolvimento' text.")
        except:
             print("Could not find 'Em Desenvolvimento' text.")

        # Take screenshot
        page.screenshot(path="verification_coming_soon.png")
        print("Coming soon screenshot taken.")

        browser.close()

if __name__ == "__main__":
    verify_coming_soon()
