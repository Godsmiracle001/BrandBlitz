import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardAnswers } from "./use-keyboard-answers";

describe("useKeyboardAnswers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("calls onAnswer with 'A' when A key is pressed", () => {
    const onAnswer = vi.fn();
    renderHook(() => useKeyboardAnswers({ onAnswer }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(onAnswer).toHaveBeenCalledWith("A");
  });

  it("calls onAnswer with 'B' when B key is pressed", () => {
    const onAnswer = vi.fn();
    renderHook(() => useKeyboardAnswers({ onAnswer }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    expect(onAnswer).toHaveBeenCalledWith("B");
  });

  it("calls onAnswer with 'C' when C key is pressed", () => {
    const onAnswer = vi.fn();
    renderHook(() => useKeyboardAnswers({ onAnswer }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    expect(onAnswer).toHaveBeenCalledWith("C");
  });

  it("calls onAnswer with 'D' when D key is pressed", () => {
    const onAnswer = vi.fn();
    renderHook(() => useKeyboardAnswers({ onAnswer }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
    expect(onAnswer).toHaveBeenCalledWith("D");
  });

  it("calls onAnswer with numeric keys 1-4 mapped to A-D", () => {
    const onAnswer = vi.fn();
    renderHook(() => useKeyboardAnswers({ onAnswer }));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    expect(onAnswer).toHaveBeenCalledWith("A");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    expect(onAnswer).toHaveBeenCalledWith("B");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "3" }));
    expect(onAnswer).toHaveBeenCalledWith("C");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "4" }));
    expect(onAnswer).toHaveBeenCalledWith("D");
  });

  it("does not call onAnswer when disabled is true", () => {
    const onAnswer = vi.fn();
    renderHook(() => useKeyboardAnswers({ onAnswer, disabled: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("does not call onAnswer for non-answer keys", () => {
    const onAnswer = vi.fn();
    renderHook(() => useKeyboardAnswers({ onAnswer }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("does not call onAnswer when an input field is focused", () => {
    const onAnswer = vi.fn();
    renderHook(() => useKeyboardAnswers({ onAnswer }));

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(onAnswer).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("calls the latest onAnswer callback when handler is captured by ref", () => {
    const onAnswer1 = vi.fn();
    const onAnswer2 = vi.fn();
    const { rerender } = renderHook(
      ({ onAnswer }) => useKeyboardAnswers({ onAnswer }),
      { initialProps: { onAnswer: onAnswer1 } }
    );

    rerender({ onAnswer: onAnswer2 });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(onAnswer1).not.toHaveBeenCalled();
    expect(onAnswer2).toHaveBeenCalledWith("A");
  });
});
