import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CountdownTimer } from './countdown-timer';

describe('CountdownTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure document is visible and window is focused between tests
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts at totalSeconds, decrements each second', () => {
    render(<CountdownTimer durationSeconds={10} />);
    
    expect(screen.getByText('10')).not.toBeNull();
    
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('9')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('7')).not.toBeNull();
  });

  it('progress bar fills accurately', () => {
    const { container } = render(<CountdownTimer durationSeconds={10} />);
    
    const innerBar = container.querySelector('[role="progressbar"] > div') as HTMLElement;
    
    expect(innerBar).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(innerBar.style.transform).toBe('translateX(-50%)');
  });

  it('red pulse visible when < 5 s remaining (class check)', () => {
    render(<CountdownTimer durationSeconds={10} />);
    
    const spanEl = screen.getByText('10');
    expect(spanEl.className).not.toContain('text-red-500');

    act(() => {
      vi.advanceTimersByTime(5100);
    });
    
    const spanElUpdated = screen.getByText('5');
    expect(spanElUpdated.className).toContain('text-red-500');
    expect(spanElUpdated.className).toContain('animate-pulse');
  });

  it('onComplete fires exactly once at 0', () => {
    const onExpireMock = vi.fn();
    render(<CountdownTimer durationSeconds={10} onExpire={onExpireMock} />);

    act(() => {
      vi.advanceTimersByTime(9900);
    });
    expect(onExpireMock).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onExpireMock).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onExpireMock).toHaveBeenCalledTimes(1);
  });

  it('survives totalSeconds change (resets cleanly)', () => {
    const { rerender } = render(<CountdownTimer durationSeconds={10} />);
    
    expect(screen.getByText('10')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('7')).not.toBeNull();

    rerender(<CountdownTimer durationSeconds={8} />);
    expect(screen.getByText('8')).not.toBeNull();
    
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('7')).not.toBeNull();
  });

  it('does not leak intervals on unmount', () => {
    const { unmount } = render(<CountdownTimer durationSeconds={10} />);

    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('timer does not advance while tab is hidden (visibilitychange pause, #346)', () => {
    // Simulate a visible tab
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });

    render(<CountdownTimer durationSeconds={10} />);
    expect(screen.getByText('10')).not.toBeNull();

    // Advance 2 seconds while visible
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('8')).not.toBeNull();

    // Hide the tab — timer should pause
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // Advance 5 seconds while hidden — timer shows Paused indicator
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText('Paused')).not.toBeNull();

    // Restore the tab — timer resumes from where it paused
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // 1 more second passes — should now show 7
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('7')).not.toBeNull();
  });

  it('parent re-renders with new onExpire identity do not restart the timer', () => {
    const onExpire = vi.fn();

    function Parent({ tick }: { tick: number }) {
      // New arrow function every render — old bug would restart timer each time
      return <CountdownTimer durationSeconds={5} onExpire={() => { onExpire(); void tick; }} />;
    }

    const { rerender } = render(<Parent tick={0} />);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('4')).not.toBeNull();

    for (let i = 1; i <= 10; i++) {
      rerender(<Parent tick={i} />);
    }

    // Timer should have continued from 4s left, not restarted
    act(() => { vi.advanceTimersByTime(4000); });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('pauses on window blur and shows Paused indicator', () => {
    render(<CountdownTimer durationSeconds={10} />);
    expect(screen.getByText('10')).not.toBeNull();

    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('8')).not.toBeNull();

    // Simulate window blur
    act(() => { window.dispatchEvent(new Event('blur')); });

    // Should show Paused indicator
    expect(screen.getByText('Paused')).not.toBeNull();

    // Timer should not advance while blurred
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText('Paused')).not.toBeNull();

    // Resume on focus
    act(() => { window.dispatchEvent(new Event('focus')); });

    // Paused indicator should disappear
    expect(screen.queryByText('Paused')).toBeNull();

    // Timer resumes from correct remaining time
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('7')).not.toBeNull();
  });

});
