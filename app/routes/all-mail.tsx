// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";
import { Outlet } from "react-router";
import Header from "~/components/Header";
import Sidebar from "~/components/Sidebar";
import { useUIStore } from "~/hooks/useUIStore";

export default function AllMailRoute() {
	const {
		isSidebarOpen,
		closeSidebar,
		closeComposeModal,
		closePanel,
	} = useUIStore();

	useEffect(() => {
		closeComposeModal();
		closePanel();
	}, [closeComposeModal, closePanel]);

	return (
		<div className="flex h-screen overflow-hidden">
			{isSidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/30 md:hidden"
					onClick={closeSidebar}
					onKeyDown={(e) => e.key === "Escape" && closeSidebar()}
					role="button"
					tabIndex={-1}
					aria-label="Close sidebar"
				/>
			)}

			<div
				className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-0 ${
					isSidebarOpen ? "translate-x-0" : "-translate-x-full"
				}`}
			>
				<Sidebar />
			</div>

			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				<Header />
				<main className="flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
