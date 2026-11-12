import { Button } from "./Button.js";

export function ErrorState({ title = "暂时无法加载", description, onRetry }: {
  readonly title?: string;
  readonly description: string;
  readonly onRetry?: () => void;
}) {
  return (
    <section className="ui-state ui-state--error" role="alert">
      <h2 className="ui-state__title">{title}</h2>
      <p className="ui-state__copy">{description}</p>
      {onRetry === undefined ? null : (
        <div className="ui-state__action">
          <Button variant="secondary" onClick={onRetry}>重试</Button>
        </div>
      )}
    </section>
  );
}
