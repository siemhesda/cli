
const normalizeData = require('normalize-package-data')
const { sep } = require('path')
const relativePrefix = `.${sep}`
const npa = require('npm-package-arg')
const ssri = require('ssri')
const uuid = require('uuid')

const SPDX_SCHEMA_VERSION = 'SPDX-2.3'
const SPDX_DATA_LICENSE = 'CC0-1.0'
const SPDX_IDENTIFER = 'SPDXRef-DOCUMENT'

const spdxOutput = ({ npm, nodes, packageType }) => {
  const rootNode = nodes.find(node => node.isRoot)
  const childNodes = nodes.filter(node => !node.isRoot)
  const rootID = rootNode.pkgid
  const ns = `http://spdx.org/spdxdocs/${npa(rootID).escapedName}-${rootNode.version}-${uuid.v4()}`

  const relationships = nodes.map(node =>
    [...node.edgesOut.values()]
      // Filter out edges that are linking to nodes not in the list
      .filter(edge => nodes.find(n => n.pkgid === edge.to?.pkgid))
      .map(edge => toSpdxRelationship(node, edge))
      .filter(rel => rel)
  ).flat()

  const bom = {
    spdxVersion: SPDX_SCHEMA_VERSION,
    dataLicense: SPDX_DATA_LICENSE,
    SPDXID: SPDX_IDENTIFER,
    name: rootID,
    documentNamespace: ns,
    creationInfo: {
      created: new Date().toISOString(),
      creators: [
        `Tool: npm/cli-${npm.version}`,
      ],
    },
    documentDescribes: [toSpdxID(rootID)],
    packages: [toSpdxItem(rootNode, { packageType }), ...childNodes.map(toSpdxItem)],
    relationships: [
      {
        spdxElementId: SPDX_IDENTIFER,
        relatedSpdxElement: toSpdxID(rootID),
        relationshipType: 'DESCRIBES',
      },
      ...relationships,
    ],
  }

  return bom
}

const toSpdxItem = (node, { packageType }) => {
  normalizeData(node.package)
  console.error(node.package.license)
  const id = node.pkgid

  const package = {
    name: node.name,
    SPDXID: toSpdxID(id),
    versionInfo: node.version,
    packageFileName: node.location,
    description: node.package?.description || undefined,
    primaryPackagePurpose: packageType ? packageType.toUpperCase() : undefined,
    downloadLocation: (node.isLink ? undefined : node.resolved) || 'NOASSERTION',
    filesAnalyzed: false,
    homePage: node.package?.homepage || 'NOASSERTION',
    licenseDeclared: node.package?.license || 'NOASSERTION',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'npm',
        referenceLocator: id,
      },
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: npa.toPurl(id) + (isGitNode(node) ? `?vcs_url=${node.resolved}` : ''),
      },
    ],
  }

  if (node.integrity) {
    const integrity = ssri.parse(node.integrity, { single: true })
    package.checksums = [{
      algorithm: integrity.algorithm.toUpperCase(),
      checksumValue: integrity.hexDigest(),
    }]
  }

  return package
}

const toSpdxRelationship = (node, edge) => {
  // Missing edge.to means that the edge is a link to a package that is not in
  // the tree
  if (!edge.to) {
    return null
  }

  let type
  switch (edge.type) {
    case 'peer':
      type = 'HAS_PREREQUISITE'
      break
    case 'optional':
      type = 'OPTIONAL_DEPENDENCY_OF'
      break
    case 'dev':
      type = 'DEV_DEPENDENCY_OF'
      break
    default:
      type = 'DEPENDS_ON'
  }

  return {
    spdxElementId: toSpdxID(node.pkgid),
    relatedSpdxElement: toSpdxID(edge.to.pkgid),
    relationshipType: type,
  }
}

const toSpdxID = (id) => {
  let name = id
  // Strip leading @ for scoped packages
  name = name.replace(/^@/, '')

  // Replace slashes with dots
  name = name.replace(/\//g, '.')

  // Replace @ with -
  name = name.replace(/@/g, '-')

  return `SPDXRef-Package-${name}`
}

const isGitNode = (node) => {
  if (!node.resolved) {
    return
  }

  try {
    const { type } = npa(node.resolved)
    return type === 'git' || type === 'hosted'
  } catch (err) {
    return false
  }
}

module.exports = { spdxOutput }
