import { IconPlaceholder } from "@/components/icon-placeholder";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";

const actions = [
	{
		title: "Add product",
		description: "Create a new SKU.",
		href: "#",
		icon: (
			<IconPlaceholder
				aria-hidden="true"
				hugeicons="Add01Icon"
				lucide="PackagePlusIcon"
				phosphor="PackageIcon"
				remixicon="RiAddBoxLine"
				tabler="IconPackageImport"
			/>
		),
	},
	{
		title: "Review unfulfilled",
		description: "Orders waiting to ship.",
		href: "#",
		icon: (
			<IconPlaceholder
				aria-hidden="true"
				hugeicons="DeliveryTruck01Icon"
				lucide="TruckIcon"
				phosphor="TruckIcon"
				remixicon="RiTruckLine"
				tabler="IconTruckDelivery"
			/>
		),
	},
	{
		title: "Store settings",
		description: "Payments, checkouts etc.",
		href: "#",
		icon: (
			<IconPlaceholder
				aria-hidden="true"
				hugeicons="Settings02Icon"
				lucide="SettingsIcon"
				phosphor="GearSixIcon"
				remixicon="RiSettings3Line"
				tabler="IconSettings"
			/>
		),
	},
	{
		title: "Export sales",
		description: "CSV for accountings.",
		href: "#",
		icon: (
			<IconPlaceholder
				aria-hidden="true"
				hugeicons="Download01Icon"
				lucide="DownloadIcon"
				phosphor="DownloadSimpleIcon"
				remixicon="RiDownloadLine"
				tabler="IconDownload"
			/>
		),
	},
] as const;

export function QuickActions() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Quick actions</CardTitle>
				<CardDescription>Shortcuts to same destinations.</CardDescription>
			</CardHeader>
			<CardContent>
				<ItemGroup className="gap-0">
					{actions.map((a) => (
						<Item asChild key={a.title} size="sm">
							<a href={a.href}>
								<ItemMedia variant="icon">{a.icon}</ItemMedia>
								<ItemContent>
									<ItemTitle>{a.title}</ItemTitle>
									<ItemDescription className="line-clamp-1">
										{a.description}
									</ItemDescription>
								</ItemContent>
								<ItemActions>
									<IconPlaceholder
										aria-hidden="true"
										className="size-4 shrink-0 text-muted-foreground"
										hugeicons="ArrowRight01Icon"
										lucide="ChevronRightIcon"
										phosphor="CaretRightIcon"
										remixicon="RiArrowRightSLine"
										tabler="IconChevronRight"
									/>
								</ItemActions>
							</a>
						</Item>
					))}
				</ItemGroup>
			</CardContent>
		</Card>
	);
}
