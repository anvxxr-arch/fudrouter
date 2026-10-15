import { lazy, useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { PublicLayout } from './components/PublicLayout';
import { RequireAuth, RequireRouteCap } from './components/guards';
import { seoFor } from './lib/seo';
import { LoginPage, SignupPage } from './routes/Auth';
import { ChangelogEntryPage, ChangelogPage, PrivacyPage, TermsPage } from './routes/Changelog';
import { DocsPage } from './routes/Docs';
import { HomePage } from './routes/Home';
import { ComparePage, ModelDetailPage, ModelsPage } from './routes/Models';
import { PricingPage } from './routes/Pricing';
import { ProviderDetailPage, ProvidersPage } from './routes/Providers';

// The dashboard and admin trees are ~60 kB of source that only a signed-in
// user ever reaches. Splitting them keeps the landing bundle (the first paint
// every visitor pays for) to the public routes; the two trees arrive on demand
// the first time a /dashboard or /admin route matches.
const AdminDetail = lazy(() => import('./routes/admin').then((m) => ({ default: m.AdminDetail })));
const AdminHome = lazy(() => import('./routes/admin').then((m) => ({ default: m.AdminHome })));
const AdminSectionRoute = lazy(() => import('./routes/admin').then((m) => ({ default: m.AdminSectionRoute })));
const AccountPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.AccountPage })));
const BillingPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.BillingPage })));
const CreditsPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.CreditsPage })));
const DashboardHome = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.DashboardHome })));
const InvitePage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.InvitePage })));
const InvoicesPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.InvoicesPage })));
const KeysPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.KeysPage })));
const PayMethodsPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.PayMethodsPage })));
const PlaygroundPage2 = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.PlaygroundPage2 })));
const ProjectNewPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.ProjectNewPage })));
const ProjectPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.ProjectPage })));
const ProjectSubPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.ProjectSubPage })));
const TeamInvitesPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.TeamInvitesPage })));
const TeamMembersPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.TeamMembersPage })));
const TeamRolesPage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.TeamRolesPage })));
const UsagePage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.UsagePage })));
const WorkspacePage = lazy(() => import('./routes/dashboard').then((m) => ({ default: m.WorkspacePage })));

function ProjectSubRoute() {
  const { name } = useParams();
  return <ProjectSubPage name={name ?? ''} />;
}
// Route metadata is NOT re-listed here. It lives in lib/seo.ts, the registry the
// Express server reads for /sitemap.xml and for the head it renders on the first
// paint. This hook only keeps the client in step after the SPA takes over: the
// same title, description, canonical and robots tag, from the same table, so a
// client-side navigation cannot leave a stale title behind.
//
// The inline TITLES regex table this replaced is what made the two planes
// disagree: it knew fourteen titles and no descriptions, and it could not tell
// the server anything.
function RouteMeta() {
  const { pathname } = useLocation();
  useEffect(() => {
    const meta = seoFor(pathname);
    document.title = meta.title;
    const setTag = (selector: string, attrs: Record<string, string>) => {
      let el = document.head.querySelector(selector) as HTMLMetaElement | HTMLLinkElement | null;
      if (!el) {
        el = document.createElement(selector.startsWith('link') ? 'link' : 'meta');
        document.head.appendChild(el);
      }
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    };
    setTag('meta[name="description"]', { name: 'description', content: meta.description });
    setTag('link[rel="canonical"]', { rel: 'canonical', href: window.location.origin + pathname });
    setTag('meta[name="robots"]', { name: 'robots', content: meta.indexable ? 'index,follow' : 'noindex,follow' });
    setTag('meta[property="og:title"]', { property: 'og:title', content: meta.title });
    setTag('meta[property="og:description"]', { property: 'og:description', content: meta.description });
    setTag('meta[property="og:url"]', { property: 'og:url', content: window.location.origin + pathname });
    setTag('meta[name="twitter:title"]', { name: 'twitter:title', content: meta.title });
    setTag('meta[name="twitter:description"]', { name: 'twitter:description', content: meta.description });
  }, [pathname]);
  return null;
}
function NotFoundPage() {
  return (
    <div className="stack">
      <h1>Page not found</h1>
      <p className="muted">No page lives at this URL.</p>
      <p><Link to="/">Back to home.</Link></p>
    </div>
  );
}
export default function App() {
  return (
    <BrowserRouter>
      <RouteMeta />
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<HomePage />} />
          <Route path="models" element={<ModelsPage />} />
          <Route path="models/compare" element={<ComparePage />} />
          <Route path="models/:slug" element={<ModelDetailPage />} />
          <Route path="providers" element={<ProvidersPage />} />
          <Route path="providers/:slug" element={<ProviderDetailPage />} />
          <Route path="pricing" element={<PricingPage />} />
          <Route path="docs" element={<DocsPage />} />
          <Route path="docs/*" element={<DocsPage />} />
          <Route path="changelog" element={<ChangelogPage />} />
          <Route path="changelog/:slug" element={<ChangelogEntryPage />} />
          <Route path="legal/terms" element={<TermsPage />} />
          <Route path="legal/privacy" element={<PrivacyPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
          <Route path="dashboard" element={<RequireAuth><DashboardHome /></RequireAuth>} />
          <Route path="dashboard/keys" element={<RequireAuth><KeysPage /></RequireAuth>} />
          <Route path="dashboard/usage" element={<RequireAuth><UsagePage /></RequireAuth>} />
          <Route path="dashboard/billing" element={<RequireAuth><BillingPage /></RequireAuth>} />
          <Route path="dashboard/billing/credits" element={<RequireAuth><CreditsPage /></RequireAuth>} />
          <Route path="dashboard/billing/invoices" element={<RequireAuth><InvoicesPage /></RequireAuth>} />
          <Route path="dashboard/billing/payment-methods" element={<RequireAuth><PayMethodsPage /></RequireAuth>} />
          <Route path="dashboard/account" element={<RequireAuth><AccountPage /></RequireAuth>} />
          <Route path="dashboard/workspace" element={<RequireAuth><WorkspacePage /></RequireAuth>} />
          <Route path="dashboard/team/members" element={<RequireAuth><TeamMembersPage /></RequireAuth>} />
          <Route path="dashboard/team/invitations" element={<RequireAuth><TeamInvitesPage /></RequireAuth>} />
          <Route path="dashboard/team/roles" element={<RequireAuth><TeamRolesPage /></RequireAuth>} />
          <Route path="dashboard/projects/new" element={<RequireAuth><ProjectNewPage /></RequireAuth>} />
          <Route path="dashboard/projects/:projectId" element={<RequireAuth><ProjectPage /></RequireAuth>} />
          <Route path="dashboard/projects/:projectId/playground" element={<RequireAuth><PlaygroundPage2 /></RequireAuth>} />
          <Route path="dashboard/projects/:projectId/:name" element={<RequireAuth><ProjectSubRoute /></RequireAuth>} />
          <Route path="invite/:token" element={<RequireAuth><InvitePage /></RequireAuth>} />
          <Route path="admin" element={<RequireRouteCap><AdminHome /></RequireRouteCap>} />
          <Route path="admin/:name" element={<RequireRouteCap><AdminSectionRoute /></RequireRouteCap>} />
          <Route path="admin/:section/:id" element={<RequireRouteCap><AdminDetail /></RequireRouteCap>} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
