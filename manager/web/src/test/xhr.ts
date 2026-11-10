/** XMLHttpRequest double for upload tests: the test decides when and how the "server" answers. */
export class FakeXhr {
  static instances: FakeXhr[] = [];
  static reset(): void {
    FakeXhr.instances = [];
  }
  static last(): FakeXhr {
    const x = FakeXhr.instances[FakeXhr.instances.length - 1];
    if (!x) throw new Error("no FakeXhr created yet");
    return x;
  }

  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: unknown): void {
    this.body = body;
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, json: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
}
