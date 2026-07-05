// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { setStatus } from "./statusBar";

beforeEach(() => {
  document.body.innerHTML = `<div id="statusBar" class="hidden"></div>`;
});

function statusBarElement(): HTMLElement {
  const element = document.getElementById("statusBar");
  if (!element) throw new Error("statusBar missing from fixture");
  return element;
}

describe("setStatus", () => {
  it("shows an info message with a spinner", () => {
    setStatus("Searching…");
    const statusBar = statusBarElement();
    expect(statusBar.className).toBe("status-bar info");
    expect(statusBar.querySelector(".spinner")).not.toBeNull();
    expect(statusBar.textContent).toContain("Searching…");
  });

  it("shows success and error messages without a spinner", () => {
    setStatus("Done", "success");
    expect(statusBarElement().className).toBe("status-bar success");
    expect(statusBarElement().querySelector(".spinner")).toBeNull();

    setStatus("Failed", "error");
    expect(statusBarElement().className).toBe("status-bar error");
    expect(statusBarElement().querySelector(".spinner")).toBeNull();
  });

  it("hides the bar when the message is null", () => {
    setStatus("Working");
    setStatus(null);
    expect(statusBarElement().classList.contains("hidden")).toBe(true);
  });

  it("escapes HTML in the message", () => {
    setStatus("<img src=x>", "error");
    expect(statusBarElement().querySelector("img")).toBeNull();
    expect(statusBarElement().textContent).toContain("<img src=x>");
  });
});
