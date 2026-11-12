import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardHeader } from "../components/ui/Card.js";
import { Input } from "../components/ui/Input.js";
import { Table } from "../components/ui/Table.js";

const TYPE_STEPS = [12, 14, 16, 20, 24, 32, 48, 64] as const;
const SPACE_STEPS = [4, 8, 12, 16, 24, 32, 48, 64] as const;
const THEMES = ["paper", "graphite", "afterglow"] as const;

export function TokensPage() {
  if (!import.meta.env.DEV) {
    return (
      <section className="ui-state">
        <h2 className="ui-state__title">Token sheet</h2>
        <p className="ui-state__copy">该页面只在开发环境可用。</p>
      </section>
    );
  }

  return (
    <article className="tokens-page">
      <header className="tokens-page__header">
        <h1>设计 token</h1>
        <p>8 级字阶、8 级间距、5 级圆角，以及三套主题下的 primitive。</p>
      </header>

      <section className="tokens-page__section" aria-labelledby="type-scale">
        <h2 id="type-scale">字阶</h2>
        <div className="tokens-page__type">
          {TYPE_STEPS.map((size, index) => (
            <p key={size} style={{ fontSize: `var(--text-${index + 1})` }}>
              {size}px · 春季歌手赛 ArtFlow 2026
            </p>
          ))}
        </div>
      </section>

      <section className="tokens-page__section" aria-labelledby="space-scale">
        <h2 id="space-scale">间距</h2>
        <div className="tokens-page__space">
          {SPACE_STEPS.map((size, index) => (
            <div key={size} className="tokens-page__space-row">
              <code>{`--space-${index + 1}`}</code>
              <span style={{ width: `var(--space-${index + 1})` }} />
              <small>{size}px</small>
            </div>
          ))}
        </div>
      </section>

      <section className="tokens-page__section" aria-labelledby="themes">
        <h2 id="themes">主题与 primitive</h2>
        <div className="tokens-page__themes">
          {THEMES.map((theme) => (
            <div key={theme} className="tokens-page__theme" data-theme={theme}>
              <h3>{theme}</h3>
              <div className="tokens-page__row">
                <Button variant="primary">主操作</Button>
                <Button variant="secondary">次操作</Button>
                <Button variant="ghost">文字</Button>
                <Button variant="danger">危险</Button>
              </div>
              <div className="tokens-page__row">
                <Badge tone="success">进行中</Badge>
                <Badge tone="warning">待审核</Badge>
                <Badge tone="danger">已拒绝</Badge>
                <Badge tone="neutral">已归档</Badge>
              </div>
              <Input label="活动名称" placeholder="春季歌手赛" />
              <Card>
                <CardHeader title="活动摘要" description="3 个活动 · 1 个需要处理" />
              </Card>
              <Table caption="示例表格">
                <thead><tr><th scope="col">活动</th><th scope="col" className="ui-table__num">报名</th></tr></thead>
                <tbody><tr><td data-label="活动">春季歌手赛</td><td data-label="报名" className="ui-table__num">48</td></tr></tbody>
              </Table>
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}
