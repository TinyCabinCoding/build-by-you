#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function xmlEscape(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function ensureFile(filePath) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Required file is missing: ${filePath}`);
	}
}

function copyFile(from, to) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.copyFileSync(from, to);
}

function writeText(filePath, contents) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, contents, 'utf8');
}

function createManifest(pkg) {
	const repositoryUrl = pkg.repository?.url ?? '';
	const sourceUrl = repositoryUrl.endsWith('.git') ? repositoryUrl : `${repositoryUrl}.git`;
	const learnUrl = repositoryUrl ? `${repositoryUrl.replace(/\.git$/, '')}#readme` : '';
	const supportUrl = repositoryUrl ? `${repositoryUrl.replace(/\.git$/, '')}/issues` : '';
	const tags = Array.isArray(pkg.keywords) ? pkg.keywords.join(',') : '';
	const categories = Array.isArray(pkg.categories) ? pkg.categories.join(',') : '';

	return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="${xmlEscape(pkg.name)}" Version="${xmlEscape(pkg.version)}" Publisher="${xmlEscape(pkg.publisher)}" />
		<DisplayName>${xmlEscape(pkg.displayName)}</DisplayName>
		<Description xml:space="preserve">${xmlEscape(pkg.description ?? '')}</Description>
		<Tags>${xmlEscape(tags)}</Tags>
		<Categories>${xmlEscape(categories)}</Categories>
		<GalleryFlags>Public</GalleryFlags>
		<Properties>
			<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(pkg.engines?.vscode ?? '')}" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
			<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
			<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
			<Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xmlEscape(sourceUrl)}" />
			<Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="${xmlEscape(sourceUrl)}" />
			<Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${xmlEscape(sourceUrl)}" />
			<Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${xmlEscape(supportUrl)}" />
			<Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${xmlEscape(learnUrl)}" />
			<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
			<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
		</Properties>
		<License>extension/LICENSE.txt</License>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
	</Installation>
	<Dependencies/>
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
	</Assets>
</PackageManifest>
`;
}

function createContentTypes() {
	return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>
`;
}

function main() {
	const repoRoot = process.cwd();
	const pkgPath = path.join(repoRoot, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	const outFile = path.join(repoRoot, `buildbyyou-${pkg.version}.vsix`);
	const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildbyyou-vsix-'));
	const extensionRoot = path.join(stagingRoot, 'extension');

	const requiredFiles = [
		path.join(repoRoot, 'dist', 'extension.js'),
		pkgPath,
		path.join(repoRoot, 'README.md'),
		path.join(repoRoot, 'CHANGELOG.md'),
		path.join(repoRoot, 'LICENSE'),
	];

	requiredFiles.forEach(ensureFile);

	copyFile(path.join(repoRoot, 'dist', 'extension.js'), path.join(extensionRoot, 'dist', 'extension.js'));
	copyFile(pkgPath, path.join(extensionRoot, 'package.json'));
	copyFile(path.join(repoRoot, 'README.md'), path.join(extensionRoot, 'readme.md'));
	copyFile(path.join(repoRoot, 'CHANGELOG.md'), path.join(extensionRoot, 'changelog.md'));
	copyFile(path.join(repoRoot, 'LICENSE'), path.join(extensionRoot, 'LICENSE.txt'));

	writeText(path.join(stagingRoot, 'extension.vsixmanifest'), createManifest(pkg));
	writeText(path.join(stagingRoot, '[Content_Types].xml'), createContentTypes());

	if (fs.existsSync(outFile)) {
		fs.rmSync(outFile, { force: true });
	}

	execFileSync('zip', ['-qr', outFile, '.'], { cwd: stagingRoot, stdio: 'inherit' });
	console.log(`Packaged ${path.basename(outFile)}`);
}

main();
