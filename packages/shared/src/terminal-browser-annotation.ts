export interface TerminalBrowserAnnotationPoint {
  x: number;
  y: number;
}

export interface TerminalBrowserAnnotationViewport {
  width: number;
  height: number;
}

export interface TerminalBrowserAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalBrowserAnnotationTarget {
  pageUrl: string;
  frameLabel: string;
  targetText: string;
  targetSelector: string;
  targetPath: string;
  nodePosition: TerminalBrowserAnnotationPoint;
  viewport: TerminalBrowserAnnotationViewport;
  rect: TerminalBrowserAnnotationRect;
  devicePixelRatio: number;
}

export interface TerminalBrowserAnnotationDraft {
  id: string;
  index: number;
  comment: string;
  target: TerminalBrowserAnnotationTarget;
}

export interface TerminalBrowserAnnotationScreenshot {
  mimeType: "image/png";
  dataBase64: string;
}

export interface TerminalBrowserAnnotationState {
  active: boolean;
  annotations: TerminalBrowserAnnotationDraft[];
  pendingSubmitRequestId?: string | null;
}

export interface TerminalBrowserAnnotationSubmission {
  annotations: TerminalBrowserAnnotationDraft[];
  screenshot: TerminalBrowserAnnotationScreenshot | null;
}
