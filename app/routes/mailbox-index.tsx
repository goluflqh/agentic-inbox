// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Navigate, useLocation } from "react-router";

export default function MailboxIndexRoute() {
  const location = useLocation();
  return <Navigate to={`emails/inbox${location.search}`} replace state={location.state} />;
}
