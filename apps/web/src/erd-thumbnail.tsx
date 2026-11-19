import { useEffect, useRef, useState } from 'react';
import { Icon } from './editor-controls.js';
import { apiRequest } from './project-api.js';

interface Thumbnail {
  boxes: { x: number; y: number }[];
  links: [number, number][];
}

export function ErdThumbnail({ id, revision }: { id: string; revision: number }) {
  const element = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<{ revision: number; image: Thumbnail }>();
  useEffect(() => {
    if (!element.current) return;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void apiRequest<Thumbnail>('/erds/' + id + '/thumbnail').then(image => {
        if (active) setPreview({ revision, image });
      }).catch(() => undefined);
    }, { rootMargin: '120px' });
    observer.observe(element.current);
    return () => { active = false; observer.disconnect(); };
  }, [id, revision]);

  const image = preview?.revision === revision ? preview.image : undefined;
  return <span className="erd-thumbnail" ref={element} aria-hidden="true">
    {image?.boxes.length ? <svg viewBox="0 0 112 68">
      {image.links.map(([from, to]) => <path className="thumbnail-link" key={from + ':' + to}
        d={`M${image.boxes[from].x} ${image.boxes[from].y} L${image.boxes[to].x} ${image.boxes[to].y}`} />)}
      {image.boxes.map(({ x, y }, index) => <g key={index} transform={`translate(${x}, ${y})`}>
        <rect className="thumbnail-box" x="-10" y="-7" width="20" height="14" rx="2.2" />
        <path className="thumbnail-heading" d="M-6 -2.7H6" />
        <path className="thumbnail-field" d="M-6 1H4 M-6 4H2" />
      </g>)}
    </svg> : <Icon name="brand" />}
  </span>;
}
