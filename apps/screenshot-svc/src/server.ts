import express, { Request, Response, NextFunction } from "express";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { readFileSync } from "fs";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScreenshotRequestBody {
  url: string;
  fullPage?: boolean;
  selector?: string;
  width?: number;
  height?: number;
  waitFor?: "load" | "domcontentloaded" | "networkidle";
}

interface ScreenshotResponse {
  url: string;
  selector: string | null;
  fullPage: boolean;
  width: number;
  height: number;
  imageBase64: string;
  mimeType: "image/png";
}

interface ErrorResponse {
  error: string;
  detail?: string;
}

// ── Config ─────────────────────────────────────────────────────────────────────

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("FATAL: API_KEY env var is required");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const TIMEOUT_MS = 30_000;
const VIEWPORT_DEFAULTS = { width: 1440, height: 900 };
const VALID_WAIT_FOR = ["load", "domcontentloaded", "networkidle"] as const;

// ── Browser pool (single shared instance) ─────────────────────────────────────

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }
  return browser;
}

// ── Page helpers ───────────────────────────────────────────────────────────────

// Scroll the full page to trigger lazy-loaded content
async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const distance = 100;
      const delay = 100;
      const maxScrollTime = 15000;
      const start = Date.now();
      let lastHeight = 0;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        const currentHeight = document.documentElement.scrollHeight;
        const scrollTop = window.scrollY + window.innerHeight;

        const timedOut = Date.now() - start > maxScrollTime;
        const reachedBottom = scrollTop >= currentHeight;
        const noNewContent = currentHeight === lastHeight;

        if (timedOut || (reachedBottom && noNewContent)) {
          clearInterval(timer);
          resolve(); // scrollToTopAndSettle owns the return-to-top
        }

        lastHeight = currentHeight;
      }, delay);
    });
  });
}

// Scroll back to absolute top and verify before handing off to Playwright
async function scrollToTopAndSettle(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  });

  // Wait for scroll-linked animations / sticky header transitions to settle
  await page.waitForTimeout(800);

  // Verify we actually landed at 0 — retry once if not
  const scrollY = await page.evaluate(() => window.scrollY);
  if (scrollY > 0) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
  }
}

// Wait for all img elements to fully decode
async function waitForImages(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const images = Array.from(document.querySelectorAll("img"));
    await Promise.allSettled(
      images.map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) return resolve();
            img.onload = () => resolve();
            img.onerror = () => resolve(); // don't block on broken images
          }),
      ),
    );
  });
}

async function preparePageForCapture(page: Page): Promise<void> {
  // Disable all CSS transitions and animations so screenshot
  // captures final state rather than a mid-transition frame
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      *, *::before, *::after {
        transition: none !important;
        animation: none !important;
      }
    `;
    document.head.appendChild(style);
  });
  await page.waitForTimeout(300);
}

// ── URL validation ─────────────────────────────────────────────────────────────

function validateUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

// ── Express app ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

// Auth middleware
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" } satisfies ErrorResponse);
    return;
  }
  next();
}

// ── POST /screenshot ───────────────────────────────────────────────────────────

app.post(
  "/screenshot",
  requireApiKey,
  async (req: Request, res: Response): Promise<void> => {
    const {
      url: rawUrl,
      fullPage = true,
      selector,
      width = VIEWPORT_DEFAULTS.width,
      height = VIEWPORT_DEFAULTS.height,
      waitFor = "networkidle",
      extraWait = null, // ms to wait if needed for js to load
    } = req.body as ScreenshotRequestBody;

    const url = validateUrl(rawUrl);
    if (!url) {
      res
        .status(400)
        .json({ error: "Invalid or missing url" } satisfies ErrorResponse);
      return;
    }

    if (!VALID_WAIT_FOR.includes(waitFor as (typeof VALID_WAIT_FOR)[number])) {
      res.status(400).json({
        error: `waitFor must be one of: ${VALID_WAIT_FOR.join(", ")}`,
      } satisfies ErrorResponse);
      return;
    }

    let context: BrowserContext | null = null;

    try {
      const b = await getBrowser();
      context = await b.newContext({
        viewport: { width: Number(width), height: Number(height) },
      });
      const page = await context.newPage();

      // Navigate and wait for network to settle
      await page.goto(url, {
        waitUntil: waitFor as (typeof VALID_WAIT_FOR)[number],
        timeout: TIMEOUT_MS,
      });

      // Wait for networkidle + domcontentloaded states
      await page.waitForLoadState("domcontentloaded");
      await page.waitForLoadState("networkidle");

      // Kill transitions so screenshot catches final rendered state
      await preparePageForCapture(page);

      if (extraWait !== null) {
        await page.waitForTimeout(extraWait);
      }

      let imageBuffer: Buffer;

      if (selector) {
        // ── Selector capture ─────────────────────────────────────────────────
        const element = await page.waitForSelector(selector, {
          state: "visible",
          timeout: TIMEOUT_MS,
        });
        if (!element) {
          res.status(404).json({
            error: `Selector not found: ${selector}`,
          } satisfies ErrorResponse);
          return;
        }
        // Scroll element into view and let any lazy content inside it load
        await element.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        imageBuffer = await element.screenshot({ type: "png" });
      } else {
        // ── Full page capture ─────────────────────────────────────────────────
        // 1. Scroll entire page to trigger lazy-loaded images/content
        await autoScroll(page);

        // 2. Wait for all images triggered during scroll to decode
        await waitForImages(page);

        // 3. Return to absolute top and settle before Playwright captures
        await scrollToTopAndSettle(page);

        // 4. Capture full scrollable height from top
        imageBuffer = await page.screenshot({ type: "png", fullPage: true });
      }

      const response: ScreenshotResponse = {
        url,
        selector: selector ?? null,
        fullPage: selector ? false : fullPage,
        width: Number(width),
        height: Number(height),
        imageBase64: imageBuffer.toString("base64"),
        mimeType: "image/png",
      };

      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Screenshot error:", message);
      res.status(500).json({
        error: "Screenshot failed",
        detail: message,
      } satisfies ErrorResponse);
    } finally {
      if (context) await context.close().catch(() => {});
    }
  },
);

// ── GET /health ────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response): void => {
  res.json({ status: "ok" });
});

// ── GET /.well-known/openapi.json ─────────────────────────────────────────────

app.get("/.well-known/openapi.json", (_req: Request, res: Response): void => {
  try {
    const spec = readFileSync(join(__dirname, "../openapi.json"), "utf8");
    res.type("application/json").send(spec);
  } catch {
    res.status(404).json({ error: "OpenAPI spec not found" });
  }
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`screenshot-service listening on :${PORT}`);
});
