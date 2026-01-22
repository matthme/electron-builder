import { CancellationToken, GithubOptions, githubUrl, HttpError, newError, parseXml, ReleaseNoteInfo, UpdateInfo, XElement } from "builder-util-runtime"
import * as semver from "semver"
import { URL } from "url"
import { AppUpdater } from "../AppUpdater"
import { ResolvedUpdateFileInfo } from "../main"
import { getChannelFilename, newBaseUrl, newUrlFromBase } from "../util"
import { parseUpdateInfo, Provider, ProviderRuntimeOptions, resolveFiles } from "./Provider"

const hrefRegExp = /\/tag\/([^/]+)$/

interface GithubUpdateInfo extends UpdateInfo {
  tag: string
}
export abstract class BaseGitHubProvider<T extends UpdateInfo> extends Provider<T> {
  // so, we don't need to parse port (because node http doesn't support host as url does)
  protected readonly baseUrl: URL
  protected readonly baseApiUrl: URL

  protected constructor(
    protected readonly options: GithubOptions,
    defaultHost: string,
    runtimeOptions: ProviderRuntimeOptions
  ) {
    super({
      ...runtimeOptions,
      /* because GitHib uses S3 */
      isUseMultipleRangeRequest: false,
    })

    this.baseUrl = newBaseUrl(githubUrl(options, defaultHost))
    const apiHost = defaultHost === "github.com" ? "api.github.com" : defaultHost
    this.baseApiUrl = newBaseUrl(githubUrl(options, apiHost))
  }

  protected computeGithubBasePath(result: string): string {
    // https://github.com/electron-userland/electron-builder/issues/1903#issuecomment-320881211
    const host = this.options.host
    return host && !["github.com", "api.github.com"].includes(host) ? `/api/v3${result}` : result
  }
}

export class GitHubProvider extends BaseGitHubProvider<GithubUpdateInfo> {
  constructor(
    protected readonly options: GithubOptions,
    private readonly updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions
  ) {
    super(options, "github.com", runtimeOptions)
  }

  async getLatestVersion(): Promise<GithubUpdateInfo> {
    const cancellationToken = new CancellationToken()

    const feedXml: string = (await this.httpRequest(
      newUrlFromBase(`${this.basePath}.atom`, this.baseUrl),
      {
        accept: "application/xml, application/atom+xml, text/xml, */*",
      },
      cancellationToken
    ))!
    const feed = parseXml(feedXml)

    // Don't just pick the latest release here but look through all releases
    // and from the ones that are semver compatible with the current version,
    // take the release with the highest version.
    const allReleases = feed.getElements("entry", false)

    // Filter releases by versions that are semver compatible with the current version.
    const currentBreakingVersion = breakingVersion(this.updater.currentVersion.toString())
    const compatibleReleases = allReleases.filter(element => {
      const hrefElement = hrefRegExp.exec(element.element("link").attribute("href"))!
      const releaseTag = hrefElement[1]
      const breakingVer = breakingVersion(releaseTag)
      return breakingVer && breakingVer === currentBreakingVersion
    })

    const compatibleTags = compatibleReleases.map(element => {
      return hrefRegExp.exec(element.element("link").attribute("href"))![1]
    })

    console.log("Found compatible tags:", compatibleTags)

    const sortedReleases = compatibleTags.sort((tagA, tagB) => (semver.gt(tagA, tagB) ? -1 : 1))

    const tag = sortedReleases[0]

    if (!tag) {
      throw newError(`No published compatible versions on GitHub`, "ERR_UPDATER_NO_PUBLISHED_VERSIONS")
    }

    let rawData: string
    let channelFile = ""
    let channelFileUrl: any = ""
    const fetchData = async (channelName: string) => {
      channelFile = getChannelFilename(channelName)
      channelFileUrl = newUrlFromBase(this.getBaseDownloadPath(String(tag), channelFile), this.baseUrl)
      const requestOptions = this.createRequestOptions(channelFileUrl)
      try {
        return (await this.executor.request(requestOptions, cancellationToken))!
      } catch (e: any) {
        if (e instanceof HttpError && e.statusCode === 404) {
          throw newError(`Cannot find ${channelFile} in the latest release artifacts (${channelFileUrl}): ${e.stack || e.message}`, "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND")
        }
        throw e
      }
    }

    try {
      const channel = this.updater.allowPrerelease ? this.getCustomChannelName(String(semver.prerelease(tag)?.[0] || "latest")) : this.getDefaultChannelName()
      rawData = await fetchData(channel)
    } catch (e: any) {
      if (this.updater.allowPrerelease) {
        // Allow fallback to `latest.yml`
        rawData = await fetchData(this.getDefaultChannelName())
      } else {
        throw e
      }
    }

    const latestCompatibleRelease = allReleases.find(element => hrefRegExp.exec(element.element("link").attribute("href"))![1] === tag)


    const result = parseUpdateInfo(rawData, channelFile, channelFileUrl)
    if (result.releaseName == null) {
      result.releaseName = latestCompatibleRelease!.elementValueOrEmpty("title")
    }

    if (result.releaseNotes == null) {
      result.releaseNotes = computeReleaseNotes(this.updater.currentVersion, this.updater.fullChangelog, feed, latestCompatibleRelease)
    }
    return {
      tag: tag,
      ...result,
    }
  }

  private get basePath(): string {
    return `/${this.options.owner}/${this.options.repo}/releases`
  }

  resolveFiles(updateInfo: GithubUpdateInfo): Array<ResolvedUpdateFileInfo> {
    // still replace space to - due to backward compatibility
    return resolveFiles(updateInfo, this.baseUrl, p => this.getBaseDownloadPath(updateInfo.tag, p.replace(/ /g, "-")))
  }

  private getBaseDownloadPath(tag: string, fileName: string): string {
    return `${this.basePath}/download/${tag}/${fileName}`
  }
}

function getNoteValue(parent: XElement): string {
  const result = parent.elementValueOrEmpty("content")
  // GitHub reports empty notes as <content>No content.</content>
  return result === "No content." ? "" : result
}

export function computeReleaseNotes(currentVersion: semver.SemVer, isFullChangelog: boolean, feed: XElement, latestRelease: any): string | Array<ReleaseNoteInfo> | null {
  if (!isFullChangelog) {
    return getNoteValue(latestRelease)
  }

  const releaseNotes: Array<ReleaseNoteInfo> = []
  for (const release of feed.getElements("entry")) {
    // noinspection TypeScriptValidateJSTypes
    const versionRelease = /\/tag\/v?([^/]+)$/.exec(release.element("link").attribute("href"))![1]
    if (semver.lt(currentVersion, versionRelease)) {
      releaseNotes.push({
        version: versionRelease,
        note: getNoteValue(release),
      })
    }
  }
  return releaseNotes.sort((a, b) => semver.rcompare(a.version, b.version))
}

function breakingVersion(version: string): string | undefined {
  if (!semver.valid(version)) return undefined
  const prerelease = semver.prerelease(version)
  if (prerelease) {
    return `${semver.major(version)}.${semver.minor(version)}.${semver.patch(version)}-${prerelease[0]}`
  }
  switch (semver.major(version)) {
    case 0:
      switch (semver.minor(version)) {
        case 0:
          return `0.0.${semver.patch(version)}`
        default:
          return `0.${semver.minor(version)}.x`
      }
    default:
      return `${semver.major(version)}.x.x`
  }
}
