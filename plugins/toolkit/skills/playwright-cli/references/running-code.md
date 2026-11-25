# Running Custom Playwright Code

Use `run-code` for known multi-step interactions and scenarios that need Playwright APIs.

## Syntax

```bash
playwright-cli run-code "async page => {
  // Your Playwright code here
  // Access page.context() for browser context operations
}"
```

You can also load the function from a file:

```bash
playwright-cli run-code --filename=./my-script.js
```

The code must be a single function expression, it is wrapped in `(...)` and evaluated.
import/export/require syntax is not supported.

## Batch a known form and verify its receipt

Use the attached Runweave session with the intended tab selected. This example
uses a form in `#task` and a status element in `#receipt`. Adapt the selectors,
role names, input values, and exact receipt to the observed page and authorized
operation. Choose a receipt that identifies this submission. If you still need
to discover the task region, start with a full snapshot.

```bash
pnpm exec playwright cli -s="$RW_PLAYWRIGHT_SESSION" snapshot '#task'
```

Save this function as `submit-record.js`.

<!-- prettier-ignore -->
```js
async page => {
  const name = 'example-record-01';
  const expectedReceipt = `Saved ${name} (browser)`;
  const timeout = 3500;
  const form = page.getByRole('region', { name: 'Create fixture record', exact: true });
  const record = form.getByRole('textbox', { name: 'Record name', exact: true });
  const category = form.getByRole('combobox', { name: 'Category', exact: true });
  const save = form.getByRole('button', { name: 'Save fixture record', exact: true });
  const receipt = form.getByRole('status').and(page.getByText(expectedReceipt, { exact: true }));

  if (await form.count() !== 1 || await record.count() !== 1 ||
      await category.count() !== 1 || await save.count() !== 1) {
    throw new Error('Expected one form and one match for each action');
  }
  if (await receipt.count() > 0) {
    throw new Error('This receipt already exists. Inspect the saved record before continuing.');
  }

  await record.fill(name, { timeout });
  await category.selectOption('browser', { timeout });
  await save.click({ timeout });
  await receipt.waitFor({ state: 'visible', timeout });
  return await receipt.innerText({ timeout });
}
```

```bash
pnpm exec playwright cli -s="$RW_PLAYWRIGHT_SESSION" --raw run-code --filename=./submit-record.js
```

If the submit outcome is unknown, inspect the receipt on the original tab
before taking another action. If the connection is lost, follow the
[Runweave recovery steps](../SKILL.md#choose-the-browser-target-first) and
reattach with a fresh endpoint. Use `tab-list` to identify the original tab
and select it if needed before reading the receipt.

```bash
pnpm exec playwright cli -s="$RW_PLAYWRIGHT_SESSION" tab-list
pnpm exec playwright cli -s="$RW_PLAYWRIGHT_SESSION" snapshot '#receipt'
```

If the receipt is missing or inconclusive, check the application's saved-record
view using the submission's identifier. Retry only after confirming the
operation did not take effect. If the result remains unknown, report it and
stop that submission.

## Geolocation

```bash
# Grant geolocation permission and set location
playwright-cli run-code "async page => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 37.7749, longitude: -122.4194 });
}"

# Set location to London
playwright-cli run-code "async page => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 51.5074, longitude: -0.1278 });
}"

# Clear geolocation override
playwright-cli run-code "async page => {
  await page.context().clearPermissions();
}"
```

## Permissions

```bash
# Grant multiple permissions
playwright-cli run-code "async page => {
  await page.context().grantPermissions([
    'geolocation',
    'notifications',
    'camera',
    'microphone'
  ]);
}"

# Grant permissions for specific origin
playwright-cli run-code "async page => {
  await page.context().grantPermissions(['clipboard-read'], {
    origin: 'https://example.com'
  });
}"
```

## Media Emulation

```bash
# Emulate dark color scheme
playwright-cli run-code "async page => {
  await page.emulateMedia({ colorScheme: 'dark' });
}"

# Emulate light color scheme
playwright-cli run-code "async page => {
  await page.emulateMedia({ colorScheme: 'light' });
}"

# Emulate reduced motion
playwright-cli run-code "async page => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
}"

# Emulate print media
playwright-cli run-code "async page => {
  await page.emulateMedia({ media: 'print' });
}"
```

## Wait Strategies

```bash
# Wait for network idle
playwright-cli run-code "async page => {
  await page.waitForLoadState('networkidle');
}"

# Wait for specific element
playwright-cli run-code "async page => {
  await page.locator('.loading').waitFor({ state: 'hidden' });
}"

# Wait for function to return true
playwright-cli run-code "async page => {
  await page.waitForFunction(() => window.appReady === true);
}"

# Wait with timeout
playwright-cli run-code "async page => {
  await page.locator('.result').waitFor({ timeout: 10000 });
}"
```

## Frames and Iframes

```bash
# Work with iframe
playwright-cli run-code "async page => {
  const frame = page.locator('iframe#my-iframe').contentFrame();
  await frame.locator('button').click();
}"

# Get all frames
playwright-cli run-code "async page => {
  const frames = page.frames();
  return frames.map(f => f.url());
}"
```

## File Downloads

```bash
# Handle file download
playwright-cli run-code "async page => {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).click();
  const download = await downloadPromise;
  await download.saveAs('./downloaded-file.pdf');
  return download.suggestedFilename();
}"
```

## Clipboard

```bash
# Read clipboard (requires permission)
playwright-cli run-code "async page => {
  await page.context().grantPermissions(['clipboard-read']);
  return await page.evaluate(() => navigator.clipboard.readText());
}"

# Write to clipboard
playwright-cli run-code "async page => {
  await page.evaluate(text => navigator.clipboard.writeText(text), 'Hello clipboard!');
}"
```

## Page Information

```bash
# Get page title
playwright-cli run-code "async page => {
  return await page.title();
}"

# Get current URL
playwright-cli run-code "async page => {
  return page.url();
}"

# Get page content
playwright-cli run-code "async page => {
  return await page.content();
}"

# Get viewport size
playwright-cli run-code "async page => {
  return page.viewportSize();
}"
```

## JavaScript Execution

```bash
# Execute JavaScript and return result
playwright-cli run-code "async page => {
  return await page.evaluate(() => {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      cookiesEnabled: navigator.cookieEnabled
    };
  });
}"

# Pass arguments to evaluate
playwright-cli run-code "async page => {
  const multiplier = 5;
  return await page.evaluate(m => document.querySelectorAll('li').length * m, multiplier);
}"
```

## Error Handling

```bash
# Try-catch in run-code
playwright-cli run-code "async page => {
  try {
    await page.getByRole('button', { name: 'Submit' }).click({ timeout: 1000 });
    return 'clicked';
  } catch (e) {
    return 'element not found';
  }
}"
```

## Complex Workflows

```bash
# Login and save state
playwright-cli run-code "async page => {
  await page.goto('https://example.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
  await page.getByRole('textbox', { name: 'Password' }).fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
  await page.context().storageState({ path: 'auth.json' });
  return 'Login successful';
}"

# Scrape data from multiple pages
playwright-cli run-code "async page => {
  const results = [];
  for (let i = 1; i <= 3; i++) {
    await page.goto(\`https://example.com/page/\${i}\`);
    const items = await page.locator('.item').allTextContents();
    results.push(...items);
  }
  return results;
}"
```
