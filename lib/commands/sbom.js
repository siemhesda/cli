'use strict'

const { EOL } = require('os')
const { resolve } = require('path')
const { breadth } = require('treeverse')
const BaseCommand = require('../base-command.js')
const { cyclonedxOutput } = require('../utils/sbom-cyclonedx.js')
const { spdxOutput } = require('../utils/sbom-spdx.js')
const localeCompare = require('@isaacs/string-locale-compare')('en')

const _invalid = Symbol('invalid')
const _type = Symbol('type')
const _missing = Symbol('missing')

const SBOM_FORMATS = ['cyclonedx', 'spdx']

class SBOM extends BaseCommand {
  #response = [] // response is the sbom response

  static description = 'Generate a Software Bill of Materials (SBOM) for a project'
  static name = 'sbom'

  static workspaces = true
  static ignoreImplicitWorkspace = true

  static params = [
    'workspace',
    'workspaces',
    'sbom-format',
    'omit',
    'package-type',
    'package-lock-only',
  ]

  get parsedResponse () {
    return JSON.stringify(this.#response, null, 2)
  }

  async exec (args) {
    const sbomFormat = this.npm.config.get('sbom-format')

    if (!sbomFormat) {
      throw Object.assign(
        new Error(`Must specify --sbom-format flag with one of: ${SBOM_FORMATS.join(', ')}.`),
        { code: 'EUSAGE' }
      )
    }

    const omit = this.npm.flatOptions.omit
    const packageLockOnly = this.npm.config.get('package-lock-only')
    const workspacesEnabled = this.npm.flatOptions.workspacesEnabled

    // one dir up from wherever node_modules lives
    const where = resolve(this.npm.dir, '..')
    const Arborist = require('@npmcli/arborist')

    const opts = {
      ...this.npm.flatOptions,
      path: where,
      forceActual: true,
    }
    const arb = new Arborist(opts)

    let tree
    if (packageLockOnly) {
      try {
        tree = await arb.loadVirtual(opts)
      } catch (err) {
        /* eslint-disable-next-line max-len */
        throw this.usageError('A package lock or shrinkwrap file is required in package-lock-only mode')
      }
    } else {
      tree = await arb.loadActual(opts)
    }

    // Collect the list of workspaces in the project
    let wsNodes
    if (this.workspaceNames && this.workspaceNames.length) {
      wsNodes = arb.workspaceNodes(tree, this.workspaceNames)
    }

    const seenNodes = new Map()
    const errors = new Set()

    await breadth({
      tree,
      // recursive method, `node` is going to be the current elem (starting from
      // the `tree` obj) that was just visited in the `visit` method below
      getChildren (node) {
        const seenPaths = new Set()
        const shouldSkipChildren = !(node instanceof Arborist.Node)
        return (shouldSkipChildren) ? [] : [...(node.target).edgesOut.values()]
          .filter(filterBySelectedWorkspaces({ workspacesEnabled, wsNodes }))
          .filter(filterByEdgesTypes({ omit }))
          .map(mapEdgesToNodes({ seenPaths }))
          .concat(appendExtraneousChildren({ node, seenPaths }))
          .sort(sortAlphabetically)
      },
      visit (node) {
        findErrors(node).forEach(error => errors.add(error))

        // Collect all the visited nodes
        seenNodes.set(node.path, node)
        return Promise.resolve()
      },
    })

    if (errors.size > 0) {
      throw Object.assign(
        new Error([...errors].join(EOL)),
        { code: 'ESBOMPROBLEMS' }
      )
    }

    // Populate the response with the list of visited nodes, excluding any
    // which are missing AND optional
    this.buildResponse([...seenNodes.values()].filter(node => !node[_missing]))
    this.npm.output(this.parsedResponse)
  }

  async execWorkspaces (args) {
    await this.setWorkspaces()
    return this.exec(args)
  }

  // builds a normalized inventory
  buildResponse (items) {
    const sbomFormat = this.npm.config.get('sbom-format')
    const packageType = this.npm.config.get('package-type')
    this.#response =
        sbomFormat === 'cyclonedx'
          ? cyclonedxOutput({ npm: this.npm, nodes: items, packageType })
          : spdxOutput({ npm: this.npm, nodes: items, packageType })
  }
}

// filters by workspaces nodes when using -w <workspace-name>
// We only have to filter the first layer of edges, so we don't
// explore anything that isn't part of the selected workspace set.
const filterBySelectedWorkspaces = ({ workspacesEnabled, wsNodes }) => (edge) => {
  // Exclude all workspaces if --workspaces=false
  if (!workspacesEnabled
    && edge.from.isProjectRoot
    && edge.to.isWorkspace
  ) {
    return false
  }

  // Include all nodes if no workspaces are selected
  if (!wsNodes || !wsNodes.length) {
    return true
  }

  // Include workspace only if it is in the selected workspace set
  if (edge.from.isProjectRoot) {
    return (edge.to
    && edge.to.isWorkspace
    && wsNodes.includes(edge.to.target))
  }

  return true
}

// Return the Arborist node that the edge links to
const mapEdgesToNodes = ({ seenPaths }) => (edge) => {
  let node = edge.to

  // if the edge is linking to a missing node, we go ahead
  // and create a new obj that will represent the missing node
  if (edge.missing || (edge.optional && !node)) {
    const { name, spec } = edge
    const pkgid = `${name}@${spec}`
    node = { name, pkgid, [_missing]: edge.from.pkgid }
  }

  if (edge.invalid) {
    node[_invalid] = true
  }

  node[_type] = edge.type

  if (node.path) {
    seenPaths.add(node.path)
  }

  return node
}

const filterByEdgesTypes = ({ omit }) => (edge) => {
  return !omit.includes(edge.type)
}

// Returns any children of the supplied node which haven't already been seen
// (i.e. are not represented in the node's edgesOut)
const appendExtraneousChildren = ({ node, seenPaths }) =>
  [...node.children.values()]
    .filter(i => !seenPaths.has(i.path) && i.extraneous)

const sortAlphabetically = ({ pkgid: a }, { pkgid: b }) => localeCompare(a, b)

const findErrors = (node) => {
  const errors = []

  if (node[_missing] && !(node[_type] === 'optional' || node[_type] === 'peerOptional')) {
    errors.push(`missing: ${node.pkgid}, required by ${node[_missing]}`)
  }

  if (node[_invalid]) {
    errors.push(`invalid: ${node.pkgid} ${node.path}`)
  }

  return errors
}

module.exports = SBOM
