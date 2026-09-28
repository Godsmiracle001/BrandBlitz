import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockGetCurrentLegalDocument = vi.fn();
const mockGetLegalDocumentByVersion = vi.fn();
const mockRecordUserLegalAcceptance = vi.fn();
const mockFindUserLegalAcceptance = vi.fn();
const mockGetAcceptedVersions = vi.fn();

vi.mock("../db/queries/legal", () => ({
  getCurrentLegalDocument: mockGetCurrentLegalDocument,
  getLegalDocumentByVersion: mockGetLegalDocumentByVersion,
  recordUserLegalAcceptance: mockRecordUserLegalAcceptance,
  findUserLegalAcceptance: mockFindUserLegalAcceptance,
  getAcceptedVersions: mockGetAcceptedVersions,
}));

vi.mock("../middleware/authenticate", () => ({
  authenticate: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "No token provided" });
      return;
    }
    req.user = { sub: "user-123", email: "test@example.com", role: "player" };
    next();
  },
}));

import { errorHandler } from "../middleware/error";

let app: express.Express;

const tosDocFixture = {
  id: "doc-1",
  version: "1.0",
  type: "tos",
  body_markdown: "# Terms of Service",
  effective_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(async () => {
  vi.clearAllMocks();
  app = express();
  app.use(express.json());
  const { default: legalRouter } = await import("./legal");
  app.use("/legal", legalRouter);
  app.use(errorHandler);
});

describe("GET /legal/:type/current", () => {
  it("returns 200 with the document for an unauthenticated request", async () => {
    mockGetCurrentLegalDocument.mockResolvedValueOnce(tosDocFixture);

    const response = await request(app).get("/legal/tos/current").expect(200);

    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body.document.version).toBe("1.0");
    expect(response.body.document.body_markdown).toBe("# Terms of Service");
  });

  it("does not require authentication — no 401 from the authenticate middleware", async () => {
    mockGetCurrentLegalDocument.mockResolvedValueOnce(tosDocFixture);

    const response = await request(app).get("/legal/tos/current");

    expect(response.status).not.toBe(401);
  });

  it("returns 404 when no current version exists", async () => {
    mockGetCurrentLegalDocument.mockResolvedValueOnce(null);

    const response = await request(app).get("/legal/tos/current").expect(404);

    expect(response.body.error).toBeDefined();
  });
});

describe("GET /legal/:type/:version", () => {
  it("returns 200 with the requested version when it exists", async () => {
    mockGetLegalDocumentByVersion.mockResolvedValueOnce({ ...tosDocFixture, version: "0.9" });

    const response = await request(app).get("/legal/tos/0.9").expect(200);

    expect(response.body.document.version).toBe("0.9");
    expect(mockGetLegalDocumentByVersion).toHaveBeenCalledWith("tos", "0.9");
  });

  it("returns 404 when the requested version does not exist", async () => {
    mockGetLegalDocumentByVersion.mockResolvedValueOnce(null);

    const response = await request(app).get("/legal/tos/9.9").expect(404);

    expect(response.body.error).toBeDefined();
  });
});

describe("GET /legal/status", () => {
  it("returns 401 without auth", async () => {
    await request(app).get("/legal/status").expect(401);
  });

  it("returns 200 with an accepted flag reflecting prior acceptance for the authenticated caller", async () => {
    mockGetCurrentLegalDocument.mockImplementation(async (type: string) =>
      type === "tos" ? tosDocFixture : { ...tosDocFixture, type: "privacy", version: "2.0" }
    );
    mockFindUserLegalAcceptance.mockImplementation(async (_userId: string, type: string) =>
      type === "tos" ? { id: "acc-1", accepted_at: "2026-01-02T00:00:00.000Z" } : null
    );
    mockGetAcceptedVersions.mockResolvedValue(["1.0"]);

    const response = await request(app)
      .get("/legal/status")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    expect(response.body.tos.accepted).toBe(true);
    expect(response.body.tos.current.version).toBe("1.0");
    expect(response.body.privacy.accepted).toBe(false);
  });
});

describe("POST /legal/accept", () => {
  it("returns 401 without auth", async () => {
    await request(app)
      .post("/legal/accept")
      .send({ type: "tos", version: "1.0" })
      .expect(401);

    expect(mockRecordUserLegalAcceptance).not.toHaveBeenCalled();
  });

  it("records acceptance and returns 201 for an authenticated request", async () => {
    mockRecordUserLegalAcceptance.mockResolvedValueOnce({
      id: "acc-1",
      user_id: "user-123",
      type: "tos",
      version: "1.0",
      accepted_at: "2026-01-02T00:00:00.000Z",
      ip: "127.0.0.1",
    });

    const response = await request(app)
      .post("/legal/accept")
      .set("Authorization", "Bearer test-token")
      .send({ type: "tos", version: "1.0" })
      .expect(201);

    expect(response.body.acceptance.version).toBe("1.0");
    expect(mockRecordUserLegalAcceptance).toHaveBeenCalledWith(
      "user-123",
      "tos",
      "1.0",
      expect.any(String)
    );
  });
});
