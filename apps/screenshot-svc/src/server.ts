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
const VIEWPORT_DEFAULTS = { width: 1280, height: 800 };
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function validateUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const distance = 100;        // px per scroll step
      const delay = 100;           // ms between steps
      const maxScrollTime = 15000; // bail out after 15s
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
          window.scrollTo(0, 0); // scroll back to top before screenshot
          resolve();
        }

        lastHeight = currentHeight;
      }, delay);
    });
  });
}

// ── App ────────────────────────────────────────────────────────────────────────

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
    } = req.body as ScreenshotRequestBody;

    const url = validateUrl(rawUrl);
    if (!url) {
      res.status(400).json({ error: "Invalid or missing url" } satisfies ErrorResponse);
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

      await page.goto(url, {
        waitUntil: "networkidle", // wait for network to go quiet
        timeout: TIMEOUT_MS,
      });

      // Wait for any JS frameworks to finish rendering
      await page.waitForLoadState("domcontentloaded");
      await page.waitForLoadState("networkidle");

      // Give JS-heavy SPAs a moment to settle after networkidle
      await page.waitForTimeout(1500);

      let imageBuffer: Buffer;

      if (selector) {
        const element = await page.waitForSelector(selector, {
          state: "visible", // wait until actually visible, not just in DOM
          timeout: TIMEOUT_MS,
        });
        if (!element) {
          res.status(404).json({
            error: `Selector not found: ${selector}`,
          } satisfies ErrorResponse);
          return;
        }
        // Scroll element into view and wait for any lazy images inside it
        await element.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        imageBuffer = await element.screenshot({ type: "png" });
      } else {
        // Scroll the full page to trigger lazy loading, then screenshot
        await autoScroll(page);

        // Wait for any images that loaded during scroll to fully render
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
  }
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
