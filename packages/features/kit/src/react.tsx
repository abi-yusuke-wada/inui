import { useEffect, useState } from 'react';
import { LatestRequest } from './web.ts';

/** 画面の破棄時に、処理中の要求を取り消す。 */
export function useLatestRequest(): LatestRequest {
  const [gate] = useState(() => new LatestRequest());
  useEffect(() => () => gate.cancel(), [gate]);
  return gate;
}

export function Feedback({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="feedback feedback-error" role="alert">
    <p>{message}</p>
    {onRetry && <button className="button button-subtle" type="button" onClick={onRetry}>もう一度試す</button>}
  </div>;
}

export function Loading({ message }: { message: string }) {
  return <p className="loading-line" role="status"><span className="loading-dot" />{message}</p>;
}
