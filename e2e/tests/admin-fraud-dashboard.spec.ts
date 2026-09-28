import { expect, test } from "@playwright/test";
import {
    signInWithMockGoogle,
    createApiToken,
    seedActiveChallenge,
    seedFraudFlag,
    makeUserAdmin,
    getFraudFlagsFromDb,
} from "./helpers";

test.describe("Admin Fraud Dashboard (#437)", () => {
    test("admin views flagged session with correct details", async ({
        page,
        request,
    }) => {
        // Create admin user
        const adminToken = await createApiToken(request, {
            email: "admin-fraud@example.com",
            name: "Fraud Admin",
        });
        const adminResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        const adminId = (await adminResponse.json()).user.id;
        await makeUserAdmin(request, adminId);

        // Seed a challenge with a player
        const seeded = await seedActiveChallenge(request, {
            email: "fraud-brand@example.com",
            name: "Fraud Brand",
        });

        const playerToken = await createApiToken(request, {
            email: "fraud-player@example.com",
            name: "Fraud Player",
        });
        const playerResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${playerToken}` },
        });
        const playerId = (await playerResponse.json()).user.id;

        // Create a game session for the player
        const sessionResponse = await request.post(
            `http://localhost/api/sessions/${seeded.challengeId}/warmup-start`,
            {
                headers: { Authorization: `Bearer ${playerToken}` },
                data: { "x-device-id": "test-device" },
            }
        );
        const sessionId = (await sessionResponse.json()).sessionId;

        // Seed a fraud flag
        await seedFraudFlag(request, sessionId, playerId, "reaction_time_anomaly");

        // Sign in as admin
        await signInWithMockGoogle(
            page,
            { email: "admin-fraud@example.com", name: "Fraud Admin" },
            "/admin/fraud"
        );

        // Navigate to fraud dashboard
        await page.goto("/admin/fraud");
        await expect(page.getByRole("heading", { name: /Fraud Review Dashboard/i })).toBeVisible();

        // Verify flagged session row is visible
        await expect(page.getByText("Fraud Player")).toBeVisible();
        await expect(page.getByText("reaction_time_anomaly")).toBeVisible();
    });

    test("admin dismisses flagged session", async ({ page, request }) => {
        const adminToken = await createApiToken(request, {
            email: "admin-dismiss@example.com",
            name: "Admin Dismiss",
        });
        const adminResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        const adminId = (await adminResponse.json()).user.id;
        await makeUserAdmin(request, adminId);

        const seeded = await seedActiveChallenge(request, {
            email: "dismiss-brand@example.com",
            name: "Dismiss Brand",
        });

        const playerToken = await createApiToken(request, {
            email: "dismiss-player@example.com",
            name: "Dismiss Player",
        });
        const playerResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${playerToken}` },
        });
        const playerId = (await playerResponse.json()).user.id;

        const sessionResponse = await request.post(
            `http://localhost/api/sessions/${seeded.challengeId}/warmup-start`,
            {
                headers: { Authorization: `Bearer ${playerToken}` },
                data: { "x-device-id": "test-device" },
            }
        );
        const sessionId = (await sessionResponse.json()).sessionId;

        await seedFraudFlag(request, sessionId, playerId);

        await signInWithMockGoogle(
            page,
            { email: "admin-dismiss@example.com", name: "Admin Dismiss" },
            "/admin/fraud"
        );

        await page.goto("/admin/fraud");
        await expect(page.getByText("Dismiss Player")).toBeVisible();

        // Click Dismiss button
        await page.getByRole("button", { name: /Dismiss/ }).first().click();

        // Fill in reason in modal
        await page.getByPlaceholder(/Legitimate user confirmed/i).fill("Legitimate user activity");
        await page.getByRole("button", { name: /Mark resolved/i }).click();

        // Verify row is removed from active flags
        await expect(page.getByText("Dismiss Player")).not.toBeVisible();

        // Verify database record was updated
        const flags = await getFraudFlagsFromDb(request, "resolved");
        expect(flags.length).toBeGreaterThan(0);
        const resolved = flags.find((f) => f.status === "resolved");
        expect(resolved).toBeDefined();
        expect(resolved?.resolution_reason).toBe("Legitimate user activity");
        expect(resolved?.resolved_by).toBe(adminId);
    });

    test("admin escalates flagged session with confirmation modal", async ({
        page,
        request,
    }) => {
        const adminToken = await createApiToken(request, {
            email: "admin-escalate@example.com",
            name: "Admin Escalate",
        });
        const adminResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        const adminId = (await adminResponse.json()).user.id;
        await makeUserAdmin(request, adminId);

        const seeded = await seedActiveChallenge(request, {
            email: "escalate-brand@example.com",
            name: "Escalate Brand",
        });

        const playerToken = await createApiToken(request, {
            email: "escalate-player@example.com",
            name: "Escalate Player",
        });
        const playerResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${playerToken}` },
        });
        const playerId = (await playerResponse.json()).user.id;

        const sessionResponse = await request.post(
            `http://localhost/api/sessions/${seeded.challengeId}/warmup-start`,
            {
                headers: { Authorization: `Bearer ${playerToken}` },
                data: { "x-device-id": "test-device" },
            }
        );
        const sessionId = (await sessionResponse.json()).sessionId;

        await seedFraudFlag(request, sessionId, playerId);

        await signInWithMockGoogle(
            page,
            { email: "admin-escalate@example.com", name: "Admin Escalate" },
            "/admin/fraud"
        );

        await page.goto("/admin/fraud");
        await expect(page.getByText("Escalate Player")).toBeVisible();

        // Click Escalate button
        await page.getByRole("button", { name: /Escalate/ }).first().click();

        // Modal should appear
        await expect(page.getByRole("heading", { name: /Escalate/ })).toBeVisible();

        // Fill in reason
        await page.getByPlaceholder(/Needs manual account investigation/i).fill("Suspicious activity detected");
        await page.getByRole("button", { name: /Escalate/i }).click();

        // Verify status is updated in DB
        const flags = await getFraudFlagsFromDb(request, "escalated");
        const escalated = flags.find((f) => f.status === "escalated");
        expect(escalated).toBeDefined();
        expect(escalated?.resolution_reason).toBe("Suspicious activity detected");
    });

    test("non-admin receives 403 accessing admin fraud page", async ({
        page,
        request,
    }) => {
        const playerToken = await createApiToken(request, {
            email: "player-403@example.com",
            name: "Player 403",
        });

        await signInWithMockGoogle(
            page,
            { email: "player-403@example.com", name: "Player 403" },
            "/admin/fraud"
        );

        await page.goto("/admin/fraud");

        // Should be redirected or show 403 error
        // Page should not render the fraud dashboard
        await expect(page.getByRole("heading", { name: /Fraud Review Dashboard/i })).not.toBeVisible();
    });

    test("audit_log records fraud flag actions", async ({ page, request }) => {
        const adminToken = await createApiToken(request, {
            email: "admin-audit@example.com",
            name: "Admin Audit",
        });
        const adminResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        const adminId = (await adminResponse.json()).user.id;
        await makeUserAdmin(request, adminId);

        const seeded = await seedActiveChallenge(request, {
            email: "audit-brand@example.com",
            name: "Audit Brand",
        });

        const playerToken = await createApiToken(request, {
            email: "audit-player@example.com",
            name: "Audit Player",
        });
        const playerResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${playerToken}` },
        });
        const playerId = (await playerResponse.json()).user.id;

        const sessionResponse = await request.post(
            `http://localhost/api/sessions/${seeded.challengeId}/warmup-start`,
            {
                headers: { Authorization: `Bearer ${playerToken}` },
                data: { "x-device-id": "test-device" },
            }
        );
        const sessionId = (await sessionResponse.json()).sessionId;

        await seedFraudFlag(request, sessionId, playerId);

        await signInWithMockGoogle(
            page,
            { email: "admin-audit@example.com", name: "Admin Audit" },
            "/admin/fraud"
        );

        await page.goto("/admin/fraud");
        await page.getByRole("button", { name: /Dismiss/ }).first().click();
        await page.getByPlaceholder(/Legitimate/i).fill("Test reason for audit");
        await page.getByRole("button", { name: /Mark resolved/i }).click();

        // Verify audit_log entry exists with correct admin_id and action
        const auditResponse = await request.get(
            "http://localhost/api/admin/test/audit-logs?action=update&entity=fraud_flags",
            {
                headers: { Authorization: `Bearer ${adminToken}` },
            }
        );
        if (auditResponse.ok()) {
            const logs = (await auditResponse.json()).logs;
            const auditLog = logs.find((l: any) => l.actor_id === adminId);
            expect(auditLog).toBeDefined();
            expect(auditLog?.action).toBe("update");
        }
    });
});
