import { BrowserRouter, Route, Routes, useParams } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth, RequireRouteCap } from './components/guards';
import { LoginPage, SignupPage } from './routes/Auth';
import { ChangelogEntryPage, ChangelogPage, PrivacyPage, TermsPage } from './routes/Changelog';
import { DocsPage } from './routes/Docs';
import { HomePage } from './routes/Home';
import { ComparePage, ModelDetailPage, ModelsPage } from './routes/Models';
import { PlaygroundPage } from './routes/Playground';
import { PricingPage } from './routes/Pricing';
import { ProviderDetailPage, ProvidersPage } from './routes/Providers';
import { IncidentDetailPage, StatusPage } from './routes/Status';
import { AdminDetail, AdminHome, AdminSectionRoute } from './routes/admin';
import {
  AccountPage,
  BillingPage,
  CreditsPage,
  DashboardHome,
  InvitePage,
  InvoicesPage,
  KeysPage,
  PayMethodsPage,
  PlaygroundPage2,
  ProjectNewPage,
  ProjectPage,
  ProjectSubPage,
  TeamInvitesPage,
  TeamMembersPage,
  TeamRolesPage,
  UsagePage,
  WorkspacePage,
} from './routes/dashboard';

function ProjectSubRoute() {
  const { name } = useParams();
  return <ProjectSubPage name={name ?? ''} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="models" element={<ModelsPage />} />
          <Route path="models/compare" element={<ComparePage />} />
          <Route path="models/:slug" element={<ModelDetailPage />} />
          <Route path="providers" element={<ProvidersPage />} />
          <Route path="providers/:slug" element={<ProviderDetailPage />} />
          <Route path="pricing" element={<PricingPage />} />
          <Route path="playground" element={<PlaygroundPage />} />
          <Route path="docs" element={<DocsPage />} />
          <Route path="docs/*" element={<DocsPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="status/incidents/:id" element={<IncidentDetailPage />} />
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
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
