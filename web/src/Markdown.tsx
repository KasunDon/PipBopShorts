import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo, useState } from 'react';

marked.use({ gfm: true, breaks: false });

/** Sanitized, rendered markdown — used for compiled scripts, bibles, and settings. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [source]);
  return <div className={`md-body ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Rendered markdown with a Rendered / Source toggle. */
export function MarkdownViewer({ source, maxHeight }: { source: string; maxHeight?: number }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="md-viewer">
      <div className="md-viewer-bar">
        <div className="seg">
          <button className={!raw ? 'seg-on' : ''} onClick={() => setRaw(false)} type="button">
            Rendered
          </button>
          <button className={raw ? 'seg-on' : ''} onClick={() => setRaw(true)} type="button">
            Source
          </button>
        </div>
      </div>
      <div className="md-viewer-body" style={maxHeight ? { maxHeight } : undefined}>
        {raw ? <pre className="md-source">{source}</pre> : <Markdown source={source} />}
      </div>
    </div>
  );
}
