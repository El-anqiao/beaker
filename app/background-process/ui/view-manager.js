import path from 'path'
import Events from 'events'
import emitStream from 'emit-stream'
import { app, BrowserView, BrowserWindow } from 'electron'
import * as rpc from 'pauls-electron-rpc'
import viewsRPCManifest from '../rpc-manifests/views'

const Y_POSITION = 78 // TODO
const FIRST_TAB_URL = 'beaker://start'
const DEFAULT_URL = 'beaker://start'

// globals
// =

var activeViews = {} // map of {[win.id]: Array<View>}
var closedURLs = {} // map of {[win.id]: Array<string>}
var windowEvents = {} // mapof {[win.id]: Events}

// classes
// =

class View {
  constructor (win, opts) {
    this.browserWindow = win
    this.browserView = new BrowserView({
      webPreferences: {
        preload: path.join(__dirname, 'webview-preload.build.js'),
        allowDisplayingInsecureContent: true,
        contextIsolation: false,
        webviewTag: false,
        sandbox: true,
        defaultEncoding: 'utf-8',
        nativeWindowOpen: true,
        nodeIntegration: false,
        scrollBounce: true
      }
    })

    // webview state
    // this.url = null // current URL
    this.loadingURL = null // URL being loaded, if any
    this.title = '' // current page's title

    // browser state
    this.isActive = false // is this the active page in the window?
    this.isPinned = false // is this page pinned?

    // helper state
    this.isGuessingTheURLScheme = false // did beaker guess at the url scheme? if so, a bad load may deserve a second try
  }

  get url () {
    return this.browserView.webContents.getURL()
  }

  get state () {
    return {
      url: this.url,
      title: 'TODO',
      isActive: this.isActive,
      isPinned: this.isPinned
    }
  }

  loadURL (url) {
    // TODO manage url and loadingURL
    this.browserView.webContents.loadURL(url)
  }

  activate () {
    this.isActive = true
    const win = this.browserWindow
    win.setBrowserView(this.browserView)
    var {width, height} = win.getBounds()
    this.browserView.setBounds({x: 0, y: Y_POSITION, width, height: height - Y_POSITION})
    this.browserView.setAutoResize({width: true, height: true})
  }

  deactivate () {
    this.isActive = false
  }
}

// exported api
// =

export function getAll (win) {
  return activeViews[win.id] || []
}

export function get (win, index) {
  return getAll(win)[index]
}

export function getPinned (win) {
  return getAll(win).filter(p => p.isPinned)
}

export function getActive (win) {
  return getAll(win).find(view => view.isActive)
}

export function create (win, url) {
  url = url || DEFAULT_URL
  var view = new View(win, {})
  
  activeViews[win.id] = activeViews[win.id] || []
  activeViews[win.id].push(view)

  view.loadURL(url)

  // make active if none others are
  if (!getActive(win)) {
    // events.emit('first-page', page) TODO
    console.log('setting active')
    setActive(win, view)
  }
  emitReplaceState(win)

  return view
}

export function remove (win, view) {
  // find
  var views = getAll(win)
  var i = views.indexOf(view)
  if (i == -1) {
    return console.warn('view-manager remove() called for missing view', view)
  }

  // save, in case the user wants to restore it
  closedURLs[win.id] = closedURLs[win.id] || []
  closedURLs[win.id].push(view.url)

  // set new active if that was
  if (view.isActive) {
    if (views.length == 1) { return win.close() }
    setActive(views[i + 1] || views[i - 1])
  }

  // remove
  // view.stopLiveReloading() TODO
  views.splice(i, 1)
  view.destroy()
  // TODO update UI
  // webviewsDiv.removeChild(page.webviewEl)
  // navbar.destroyEl(page.id)
  // prompt.destroyContainer(page.id)
  // modal.destroyContainer(page.id)

  // persist pins w/o this one, if that was
  // if (page.isPinned) { savePinnedToDB() } TODO

  // emit
  // events.emit('remove', page) TODO
  // events.emit('update')
  emitReplaceState(win)
}

export function setActive (win, view) {
  var active = getActive(win)
  if (active) {
    active.deactivate()
    emitUpdateState(win, active)
  }
  if (view) {
    view.activate()
    emitUpdateState(win, view)
  }
}

export function initializeFromSnapshot (win, snapshot) {
  for (let url of snapshot) {
    create(win, url)
  }
}

export function takeSnapshot (win) {
  return getAll(win)
    .filter((p) => !p.isPinned)
    .map((p) => p.getIntendedURL())
}

export function togglePinned (win, view) {
  // TODO
}

export function reopenLastRemoved (win) {
  var url = (closedURLs[win.id] || []).pop()
  if (url) {
    var view = create(win, url)
    setActive(win, view)
    return view
  }
}

export function reorder (win, view, offset) {
  // TODO
}

export function changeActiveBy (win, offset) {
  var views = getAll(win)
  var active = getActive(win)
  if (views.length > 1) {
    var i = views.indexOf(active)
    if (i === -1) { return console.warn('Active page is not in the pages list! THIS SHOULD NOT HAPPEN!') }

    i += offset
    if (i < 0) i = views.length - 1
    if (i >= views.length) i = 0

    setActive(win, views[i])
  }
}

export function changeActiveTo (win, index) {
  var views = getAll(win)
  if (index >= 0 && index < views.length) {
    setActive(win, views[index])
  }
}

export function changeActiveToLast (win) {
  var views = getAll(win)
  setActive(win, views[views.length - 1])
}

// rpc api
// =

rpc.exportAPI('background-process-views', viewsRPCManifest, {
  createEventStream () {
    return emitStream(getEvents(getWindow(this.sender)))
  },

  async getState () {
    console.log('getState()')
    var win = getWindow(this.sender)
    return getWindowTabState(win)
  },

  async createTab () {
    console.log('createTab()')
    var win = getWindow(this.sender)
    var view = create(win)
    return getAll(win).indexOf(view)
  },

  async setActiveTab (index) {
    console.log('setActiveTab()', index)
    var win = getWindow(this.sender)
    setActive(win, get(win, index))
  },

  async reorderTab (oldIndex, newIndex) {
    var win = getWindow(this.sender)
    // TODO
  }
})

// internal methods
// =

function getWindow (sender) {
  return BrowserWindow.fromWebContents(sender)
}

function getEvents (win) {
  if (!(win.id in windowEvents)) {
    windowEvents[win.id] = new Events()
  }
  return windowEvents[win.id]
}

function emit (win, ...args) {
  getEvents(win).emit(...args)
}

function getWindowTabState (win) {
  return getAll(win).map(view => view.state)
}

function emitReplaceState (win) {
  var state = getWindowTabState(win)
  console.log('replacing state', state)
  emit(win, 'replace-state', state)
}

function emitUpdateState (win, view) {
  console.log('updating state')
  var index = typeof view === 'number' ? index : getAll(win).indexOf(view)
  if (index === -1) {
    console.warn('WARNING: attempted to update state of a view not on the window')
    return
  }
  var state = get(win, index).state
  emit(win, 'update-state', {index, state})
}