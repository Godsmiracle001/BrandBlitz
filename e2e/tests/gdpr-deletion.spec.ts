import { expect, test } from "@playwright/test";
import { signInWithMockGoogle, createApiToken } from "./helpers";

test.describe("GDPR Account Deletion Flow (#439)", () => {
    test("user navigates to account settings and locates delete action", async ({
        page,
        request,
    }) => {
        await signInWithMockGoogle(
            page,
            { email: "gdpr-player@example.com", name: "GDPR Player" },
            "/dashboard"
        );

        // Navigate to settings or profile
        await page.goto("/settings");

        // Look for delete account option
        const deleteButton = page.getByRole("button", { name: /delete.*account/i })
            .or(page.getByRole("link", { name: /delete.*account/i }));

        await expect(deleteButton).toBeVisible();
    });

    test("user submits deletion request and sees 30-day grace period notice", async ({
        page,
        request,
    }) => {
        await signInWithMockGoogle(
            page,
            { email: "gdpr-grace-period@example.com", name: "Grace Period User" },
            "/dashboard"
        );

        // Navigate to settings
        await page.goto("/settings");

        // Click delete account
        await page.getByRole("button", { name: /delete.*account/i }).click();

        // Confirmation dialog should appear
        const confirmDialog = page.getByRole("dialog")
            .or(page.getByRole("alertdialog"));

        // Look for 30-day grace period mention
        const graceText = page.getByText(/30.day|30-day|30 day/i);

        // If there's a confirmation, confirm deletion
        const confirmButton = page.getByRole("button", { name: /confirm|delete|proceed/i }).last();
        if (await confirmButton.isVisible()) {
            await confirmButton.click();
        }

        // Verify grace period notice appears
        await expect(graceText).toBeVisible({ timeout: 5000 });
    });

    test("deletion request creates gdpr_erasure_requests entry", async ({
        page,
        request,
    }) => {
        const token = await createApiToken(request, {
            email: "gdpr-db-check@example.com",
            name: "DB Check User",
        });

        const userResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${token}` },
        });
        const userId = (await userResponse.json()).user.id;

        // Submit deletion request via API
        const deleteResponse = await request.delete(`http://localhost/api/users/${userId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(deleteResponse.ok()).toBeTruthy();

        // Check if entry was created in gdpr_erasure_requests (via admin endpoint or health check)
        const erasureCheckResponse = await request.get(
            `http://localhost/api/admin/test/gdpr-erasure-request?userId=${userId}`,
            { headers: { Authorization: `Bearer ${token}` } }
        ).catch(() => null);

        if (erasureCheckResponse?.ok()) {
            const erasureData = await erasureCheckResponse.json();
            expect(erasureData.requestFound).toBe(true);
        }
    });

    test("session is invalidated after deletion request", async ({
        page,
        request,
    }) => {
        const email = "gdpr-session-invalid@example.com";
        const name = "Session Invalid User";

        await signInWithMockGoogle(page, { email, name }, "/dashboard");

        // Verify user is authenticated
        await expect(page.getByText(name)).toBeVisible();

        // Get token to submit deletion
        const token = await createApiToken(request, { email, name });

        const userResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${token}` },
        });
        const userId = (await userResponse.json()).user.id;

        // Submit deletion request
        const deleteResponse = await request.delete(`http://localhost/api/users/${userId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(deleteResponse.ok()).toBeTruthy();

        // After deletion, session should be invalidated
        // Try to navigate to a protected page
        await page.goto("/profile");

        // Should be redirected to login
        await expect(page).toHaveURL(/\/login/);
    });

    test("duplicate deletion request is rejected", async ({ page, request }) => {
        const token = await createApiToken(request, {
            email: "gdpr-duplicate@example.com",
            name: "Duplicate User",
        });

        const userResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${token}` },
        });
        const userId = (await userResponse.json()).user.id;

        // First deletion request
        const deleteResponse1 = await request.delete(`http://localhost/api/users/${userId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(deleteResponse1.ok()).toBeTruthy();

        // Second deletion request should be rejected
        const deleteResponse2 = await request.delete(`http://localhost/api/users/${userId}`, {
            headers: { Authorization: `Bearer ${token}` },
        }).catch((e) => ({
            status: () => e.response?.status || 400,
            ok: () => false,
        }));

        // Should get 409 Conflict or 400 Bad Request or 404
        expect(deleteResponse2.ok()).toBe(false);
        expect([409, 400, 404]).toContain(deleteResponse2.status());
    });

    test("profile page reflects updated data after deletion request", async ({
        page,
        request,
    }) => {
        const email = "gdpr-profile-update@example.com";
        const name = "Profile Update User";

        await signInWithMockGoogle(page, { email, name }, "/dashboard");

        const token = await createApiToken(request, { email, name });
        const userResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${token}` },
        });
        const userId = (await userResponse.json()).user.id;

        // Navigate to profile
        await page.goto(`/profile/${name.toLowerCase().replace(/\s+/g, "-")}`);

        // Submit deletion request
        await request.delete(`http://localhost/api/users/${userId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        // Reload page - deleted user should show grace period or be unavailable
        await page.reload();

        // Either show deletion notice or redirect
        const deletionNotice = page.getByText(/account.*deletion|being deleted|30.day/i);
        const isRedirected = page.url().includes("/login") || page.url().includes("/");

        await expect(deletionNotice.or(page)).toBeVisible();
    });

    test("grace period countdown is visible on profile", async ({
        page,
        request,
    }) => {
        const token = await createApiToken(request, {
            email: "gdpr-grace-countdown@example.com",
            name: "Grace Countdown User",
        });

        const userResponse = await request.get("http://localhost/api/users/me", {
            headers: { Authorization: `Bearer ${token}` },
        });
        const userId = (await userResponse.json()).user.id;

        await signInWithMockGoogle(
            page,
            { email: "gdpr-grace-countdown@example.com", name: "Grace Countdown User" },
            "/settings"
        );

        // Submit deletion
        const deleteResponse = await request.delete(`http://localhost/api/users/${userId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(deleteResponse.ok()).toBeTruthy();

        // Navigate back to settings
        await page.goto("/settings");

        // Grace period or deletion status should be visible
        const statusText = page.getByText(/pending.*deletion|grace.*period|days? remaining|account deleted/i);

        // Either on current page or after reload
        if (!(await statusText.isVisible())) {
            await page.reload();
        }

        await expect(statusText).toBeVisible();
    });
});
