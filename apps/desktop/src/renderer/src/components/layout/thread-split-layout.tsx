import { Component, useMemo, type ReactNode } from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

interface ThreadSplitLayoutProps {
  primaryId: string;
  secondaryId: string;
  primary: ReactNode;
  secondary: ReactNode;
}

class SplitLayoutBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function safeLayoutId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * A deliberately fixed two-panel tree for react-resizable-panels v4.
 *
 * v4 registers Panels and Separators from their direct mounted DOM order.
 * Building that tree through mapped Fragments while simultaneously replacing
 * the single-pane branch can leave its registration snapshot inconsistent.
 * Walle supports at most two conversation panes, so an explicit stable tree is
 * both simpler and safer.
 */
export function ThreadSplitLayout({
  primaryId,
  secondaryId,
  primary,
  secondary,
}: ThreadSplitLayoutProps) {
  const ids = useMemo(() => {
    const primaryPanel = `split-primary-${safeLayoutId(primaryId)}`;
    const secondaryPanel = `split-secondary-${safeLayoutId(secondaryId)}`;
    return {
      group: `thread-split-${safeLayoutId(primaryId)}-${safeLayoutId(secondaryId)}`,
      primaryPanel,
      secondaryPanel,
      separator: `split-separator-${safeLayoutId(primaryId)}-${safeLayoutId(secondaryId)}`,
      layout: { [primaryPanel]: 50, [secondaryPanel]: 50 },
    };
  }, [primaryId, secondaryId]);

  return (
    <SplitLayoutBoundary
      resetKey={ids.group}
      fallback={
        <div className="walle-split-fallback grid h-full min-w-0 grid-cols-2 divide-x divide-[var(--divider)]">
          <div className="min-w-0 overflow-hidden">{primary}</div>
          <div className="min-w-0 overflow-hidden">{secondary}</div>
        </div>
      }
    >
      <ResizablePanelGroup
        key={ids.group}
        id={ids.group}
        orientation="horizontal"
        defaultLayout={ids.layout}
      >
        <ResizablePanel id={ids.primaryPanel} defaultSize="50%" minSize="28%">
          {primary}
        </ResizablePanel>
        <ResizableHandle id={ids.separator} />
        <ResizablePanel id={ids.secondaryPanel} defaultSize="50%" minSize="28%">
          {secondary}
        </ResizablePanel>
      </ResizablePanelGroup>
    </SplitLayoutBoundary>
  );
}
