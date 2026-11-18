import { Card } from "../ui/Card.js";

const links = [
  {
    href: (code: string) => `/screen/${encodeURIComponent(code)}`,
    title: "现场大屏",
    description: "投影或电视：当前节目、后续节目与正式赛果。",
  },
  {
    href: (code: string) => `/host-card/${encodeURIComponent(code)}`,
    title: "主持手卡",
    description: "可打印的当前节目、流程、正式赛果与公告。",
  },
  {
    href: (code: string) => `/print/${encodeURIComponent(code)}`,
    title: "二维码打印包",
    description: "活动、报名、节目单、赛果、大屏与主持手卡二维码。",
  },
];

export function PresentationCard({ publicCode }: { readonly publicCode: string }) {
  return (
    <Card className="presentation-card">
      <h2 className="ui-card__title">现场展示</h2>
      <p className="ui-card__description">
        以下页面无需登录，只读取公开面数据；二维码应只从正式 HTTPS 域名打印。
      </p>
      <ul className="presentation-card__links">
        {links.map((link) => (
          <li key={link.title}>
            <a className="table-link" href={link.href(publicCode)} target="_blank" rel="noreferrer">
              {link.title}
            </a>
            <span>{link.description}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
