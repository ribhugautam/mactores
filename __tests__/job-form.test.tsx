import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobForm } from "@/components/job-form";
import { setTokens } from "@/lib/client/token-store";

// One schema validates on both sides, so the interesting cases are the seams: does the client stop
// bad input before it costs a round trip, and does a server rejection land on the right field?

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setTokens({ accessToken: "access", refreshToken: "refresh" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JobForm", () => {
  it("rejects a non-URL on the client without calling the server", async () => {
    const user = userEvent.setup();
    render(<JobForm />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText(/source url/i), "not a url");
    await user.click(screen.getByRole("button", { name: /create job/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/enter a full url/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a bare domain — a media source needs a path", async () => {
    const user = userEvent.setup();
    render(<JobForm />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText(/source url/i), "https://example.com");
    await user.click(screen.getByRole("button", { name: /create job/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not just a domain/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a valid URL and clears the form", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        id: "j_1",
        title: "clip.mp4",
        sourceUrl: "https://cdn.example.com/videos/clip.mp4",
        status: "NEW",
        createdAt: new Date().toISOString(),
      }),
    );

    render(<JobForm />, { wrapper: Wrapper });
    const sourceUrl = screen.getByLabelText(/source url/i);

    await user.type(sourceUrl, "https://cdn.example.com/videos/clip.mp4");
    await user.click(screen.getByRole("button", { name: /create job/i }));

    await waitFor(() => expect(sourceUrl).toHaveValue(""));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/jobs");
  });

  it("maps a server-side 422 back onto the field it belongs to", async () => {
    const user = userEvent.setup();
    // The client schema passes this one; only the server objects. That's the case where a naive
    // implementation dumps the message into a generic banner instead of onto the input.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        detail: "Validation failed",
        fieldErrors: { sourceUrl: ["That host is not on the allow-list"] },
      }),
    );

    render(<JobForm />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText(/source url/i), "https://blocked.example.com/a.mp4");
    await user.click(screen.getByRole("button", { name: /create job/i }));

    expect(await screen.findByText(/allow-list/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/source url/i)).toHaveAttribute("aria-invalid", "true");
    // The user's input survives, so they can correct it.
    expect(screen.getByLabelText(/source url/i)).toHaveValue("https://blocked.example.com/a.mp4");
  });

  it("falls back to a form-level message when the server gives no field errors", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { detail: "Unexpected server error" }));

    render(<JobForm />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText(/source url/i), "https://cdn.example.com/videos/a.mp4");
    await user.click(screen.getByRole("button", { name: /create job/i }));

    expect(await screen.findByText(/unexpected server error/i)).toBeInTheDocument();
  });
});
