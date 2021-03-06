/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import { createSelector } from 'reselect';
import { stripIndent } from 'common-tags';

import * as UrlState from '../url-state';
import * as MarkerData from '../../profile-logic/marker-data';
import * as MarkerTimingLogic from '../../profile-logic/marker-timing';
import * as ProfileSelectors from '../profile';
import { getRightClickedMarkerInfo } from '../right-clicked-marker';

import type {
  RawMarkerTable,
  ThreadIndex,
  MarkerIndex,
  Marker,
  MarkerTiming,
  MarkerTimingAndBuckets,
  DerivedMarkerInfo,
  IndexedArray,
  IndexIntoRawMarkerTable,
  Selector,
  $ReturnType,
} from 'firefox-profiler/types';

/**
 * Infer the return type from the getMarkerSelectorsPerThread function. This
 * is done that so that the local type definition with `Selector<T>` is the canonical
 * definition for the type of the selector.
 */
export type MarkerSelectorsPerThread = $ReturnType<
  typeof getMarkerSelectorsPerThread
>;

/**
 * Create the selectors for a thread that have to do with either markers.
 */
export function getMarkerSelectorsPerThread(
  threadSelectors: *,
  threadIndex: ThreadIndex
) {
  const _getRawMarkerTable: Selector<RawMarkerTable> = state =>
    threadSelectors.getThread(state).markers;

  /**
   * Similar to thread filtering, the markers can be filtered as well, and it's
   * important to use the right type of filtering for the view. The steps for filtering
   * markers are a bit different, since markers can be valid over ranges, and need a
   * bit more processing in order to get into a correct state. There are a few
   * variants of the selectors that are created for specific views that have been
   * omitted, but the ordered steps below give the general picture.
   *
   * 1. _getRawMarkerTable - Get the RawMarkerTable from the current thread.
   * 2. getProcessedRawMarkerTable - Process marker payloads out of raw strings, and
   *                                 other future processing needs. This returns a
   *                                 RawMarkerTable still.
   * 3a. _getDerivedMarkers        - Match up start/end markers, and start
   *                                 returning the Marker[] type.
   * 3b. _getDerivedJankMarkers    - Jank markers come from our samples data, and
   *                                 this selector returns Marker structures out of
   *                                 the samples structure.
   * 4. getFullMarkerList          - Concatenates and sorts all markers coming from
   *                                 different origin structures.
   * 5. getFullMarkerListIndexes   - From the full marker list, generates an array
   *                                 containing the sequence of indexes for all markers.
   * 5. getCommittedRangeFilteredMarkerIndexes - Apply the committed range.
   * 6. getSearchFilteredMarkerIndexes         - Apply the search string
   * 7. getPreviewFilteredMarkerIndexes        - Apply the preview range
   *
   * Selectors are commonly written using the utility filterMarkerIndexesCreator
   * (see below for more information about this function).
   */
  const getProcessedRawMarkerTable: Selector<RawMarkerTable> = createSelector(
    _getRawMarkerTable,
    threadSelectors.getStringTable,
    MarkerData.extractMarkerDataFromName
  );

  const _getThreadId: Selector<number | void> = state =>
    threadSelectors.getThread(state).tid;

  /* This selector exposes the result of the processing of the raw marker table
   * into our Marker structure that we use in the rest of our code. This is the
   * very start of our marker pipeline. */
  const getDerivedMarkerInfo: Selector<DerivedMarkerInfo> = createSelector(
    getProcessedRawMarkerTable,
    threadSelectors.getStringTable,
    _getThreadId,
    threadSelectors.getThreadRange,
    ProfileSelectors.getIPCMarkerCorrelations,
    MarkerData.deriveMarkersFromRawMarkerTable
  );

  const _getDerivedMarkers: Selector<Marker[]> = createSelector(
    getDerivedMarkerInfo,
    ({ markers }) => markers
  );

  const getMarkerIndexToRawMarkerIndexes: Selector<
    IndexedArray<MarkerIndex, IndexIntoRawMarkerTable[]>
  > = createSelector(
    getDerivedMarkerInfo,
    ({ markerIndexToRawMarkerIndexes }) => markerIndexToRawMarkerIndexes
  );

  /**
   * This selector constructs jank markers from the responsiveness data.
   */
  const _getDerivedJankMarkers: Selector<
    Marker[]
  > = createSelector(
    threadSelectors.getSamplesTable,
    ProfileSelectors.getDefaultCategory,
    (samples, defaultCategory) =>
      MarkerData.deriveJankMarkers(samples, 50, defaultCategory)
  );

  /**
   * This selector returns the list of all markers, this is our reference list
   * that MarkerIndex values refer to.
   */
  const getFullMarkerList: Selector<
    Marker[]
  > = createSelector(
    _getDerivedMarkers,
    _getDerivedJankMarkers,
    (derivedMarkers, derivedJankMarkers) =>
      [...derivedMarkers, ...derivedJankMarkers].sort(
        (a, b) => a.start - b.start
      )
  );

  /**
   * This selector returns a function that's used to retrieve a marker object
   * from its MarkerIndex:
   *
   *   const getMarker = selectedThreadSelectors.getMarkerGetter(state);
   *   const marker = getMarker(markerIndex);
   *
   * This is essentially the same as using the full marker list, but it's more
   * encapsulated and handles the case where a marker object isn't found (which
   * means the marker index is incorrect).
   */
  const getMarkerGetter: Selector<(MarkerIndex) => Marker> = createSelector(
    getFullMarkerList,
    markerList => (markerIndex: MarkerIndex): Marker => {
      const marker = markerList[markerIndex];
      if (!marker) {
        throw new Error(stripIndent`
          Tried to get marker index ${markerIndex} but it's not in the full list.
          This is a programming error.
        `);
      }
      return marker;
    }
  );

  /**
   * This returns the list of all marker indexes. This is simply a sequence
   * built from the full marker list.
   */
  const getFullMarkerListIndexes: Selector<
    MarkerIndex[]
  > = createSelector(getFullMarkerList, markers => markers.map((_, i) => i));

  /**
   * This utility function makes it easy to write selectors that deal with list
   * of marker indexes.
   * It takes a filtering function as parameter. This filtering function takes a
   * marker as parameter and returns a boolean deciding whether this marker
   * should be kept.
   * This function returns a function that does the actual filtering.
   *
   * It is typically used this way:
   *  const filteredMarkerIndexes = createSelector(
   *    getMarkerGetter,
   *    getSourceMarkerIndexesSelector,
   *    filterMarkerIndexesCreator(
   *      marker => MarkerData.isNetworkMarker(marker)
   *    )
   *  );
   */
  const filterMarkerIndexesCreator = (filterFunc: Marker => boolean) => (
    getMarker: MarkerIndex => Marker,
    markerIndexes: MarkerIndex[]
  ): MarkerIndex[] =>
    MarkerData.filterMarkerIndexes(getMarker, markerIndexes, filterFunc);

  /**
   * This selector applies the committed range to the full list of markers.
   */
  const getCommittedRangeFilteredMarkerIndexes: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getFullMarkerListIndexes,
    ProfileSelectors.getCommittedRange,
    (getMarker, markerIndexes, range): MarkerIndex[] => {
      const { start, end } = range;
      return MarkerData.filterMarkerIndexesToRange(
        getMarker,
        markerIndexes,
        start,
        end
      );
    }
  );

  /**
   * This selector applies the tab filter(if in a single tab view) to the range filtered markers.
   */
  const getCommittedRangeAndTabFilteredMarkerIndexes: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getCommittedRangeFilteredMarkerIndexes,
    ProfileSelectors.getRelevantInnerWindowIDsForCurrentTab,
    MarkerData.getTabFilteredMarkerIndexes
  );

  /**
   * This selector filters out markers that are usually too long to be displayed
   * in the header, because they would obscure the header, or that are displayed
   * in other tracks already.
   */
  const getCommittedRangeAndTabFilteredMarkerIndexesForHeader: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    filterMarkerIndexesCreator(
      marker =>
        marker.name !== 'BHR-detected hang' &&
        marker.name !== 'LongTask' &&
        marker.name !== 'LongIdleTask' &&
        marker.name !== 'Jank' &&
        !MarkerData.isNetworkMarker(marker) &&
        !MarkerData.isFileIoMarker(marker) &&
        !MarkerData.isNavigationMarker(marker) &&
        !MarkerData.isMemoryMarker(marker) &&
        !MarkerData.isIPCMarker(marker)
    )
  );

  /**
   * This selector applies the tab filter(if in a single tab view) to the full
   * list of markers but excludes the global markers.
   * This selector is useful to determine if a thread is completely empty or not
   * so we can hide it inside active tab view.
   */
  const getActiveTabFilteredMarkerIndexesWithoutGlobals: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getFullMarkerListIndexes,
    ProfileSelectors.getRelevantInnerWindowIDsForActiveTab,
    (markerGetter, markerIndexes, relevantPages) => {
      return MarkerData.getTabFilteredMarkerIndexes(
        markerGetter,
        markerIndexes,
        relevantPages,
        false // exclude global markers
      );
    }
  );

  /**
   * This selector selects only navigation markers.
   */
  const getTimelineVerticalMarkerIndexes: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    filterMarkerIndexesCreator(MarkerData.isNavigationMarker)
  );

  /**
   * This selector selects only jank markers.
   */
  const getJankMarkerIndexesForHeader: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    filterMarkerIndexesCreator(marker => marker.name === 'Jank')
  );

  /**
   * This selector filters markers matching a search string.
   */
  const getSearchFilteredMarkerIndexes: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    UrlState.getMarkersSearchStringsAsRegExp,
    MarkerData.getSearchFilteredMarkerIndexes
  );

  /**
   * This further filters markers using the preview selection range.
   */
  const getPreviewFilteredMarkerIndexes: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getSearchFilteredMarkerIndexes,
    ProfileSelectors.getPreviewSelection,
    (getMarker, markerIndexes, previewSelection) => {
      if (!previewSelection.hasSelection) {
        return markerIndexes;
      }
      const { selectionStart, selectionEnd } = previewSelection;
      return MarkerData.filterMarkerIndexesToRange(
        getMarker,
        markerIndexes,
        selectionStart,
        selectionEnd
      );
    }
  );

  /**
   * This selector finds out whether there's any network marker in this thread.
   */
  const getIsNetworkChartEmptyInFullRange: Selector<boolean> = createSelector(
    getFullMarkerList,
    markers => markers.every(marker => !MarkerData.isNetworkMarker(marker))
  );

  /**
   * This selector filters network markers from the range filtered markers.
   */
  const getNetworkMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeFilteredMarkerIndexes,
    filterMarkerIndexesCreator(MarkerData.isNetworkMarker)
  );

  const getUserTimingMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeFilteredMarkerIndexes,
    filterMarkerIndexesCreator(MarkerData.isUserTimingMarker)
  );

  /**
   * This filters network markers using a search string.
   */
  const getSearchFilteredNetworkMarkerIndexes: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getNetworkMarkerIndexes,
    UrlState.getNetworkSearchStringsAsRegExp,
    MarkerData.getSearchFilteredMarkerIndexes
  );

  /**
   * Returns whether there's any marker besides network markers.
   */
  const getAreMarkerPanelsEmptyInFullRange: Selector<boolean> = createSelector(
    getFullMarkerList,
    markers => markers.every(marker => MarkerData.isNetworkMarker(marker))
  );

  /**
   * This filters out network markers from the list of all markers, so that
   * they'll be displayed in the marker chart.
   */
  const getMarkerChartMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    MarkerData.filterForMarkerChart
  );

  /**
   * This filters the previous result using a search string.
   */
  const getSearchFilteredMarkerChartMarkerIndexes: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getMarkerChartMarkerIndexes,
    UrlState.getMarkersSearchStringsAsRegExp,
    MarkerData.getSearchFilteredMarkerIndexes
  );

  /**
   * This organizes the result of the previous selector in rows to be nicely
   * displayed in the marker chart.
   */
  const getMarkerChartTimingAndBuckets: Selector<MarkerTimingAndBuckets> = createSelector(
    getMarkerGetter,
    getSearchFilteredMarkerChartMarkerIndexes,
    ProfileSelectors.getCategories,
    MarkerTimingLogic.getMarkerTimingAndBuckets
  );

  /**
   * This returns only FileIO markers for the header.
   * Also excludes FileIO markers that belong to other threads.
   */
  const getFileIoMarkerIndexesForHeader: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    filterMarkerIndexesCreator(MarkerData.isOnThreadFileIoMarker)
  );

  /**
   * This returns only memory markers.
   */
  const getMemoryMarkerIndexes: Selector<
    MarkerIndex[]
  > = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    ProfileSelectors.getTimelineMemoryMarkerTypes,
    (getMarker, markerIndexes, timelineMemoryMarkerTypes) =>
      MarkerData.filterMarkerByTypes(
        getMarker,
        markerIndexes,
        timelineMemoryMarkerTypes
      )
  );

  /**
   * This returns only IPC markers.
   */
  const getIPCMarkerIndexes: Selector<MarkerIndex[]> = createSelector(
    getMarkerGetter,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    filterMarkerIndexesCreator(MarkerData.isIPCMarker)
  );

  /**
   * This organizes the network markers in rows so that they're nicely displayed
   * in the header.
   */
  const getNetworkTrackTiming: Selector<MarkerTiming[]> = createSelector(
    getMarkerGetter,
    getNetworkMarkerIndexes,
    MarkerTimingLogic.getMarkerTiming
  );

  /**
   * Creates the layout for the UserTiming markers so they can be displayed
   * with the stack chart.
   */
  const getUserTimingMarkerTiming: Selector<MarkerTiming[]> = createSelector(
    getMarkerGetter,
    getUserTimingMarkerIndexes,
    MarkerTimingLogic.getMarkerTiming
  );

  /**
   * This groups screenshot markers by their window ID.
   */
  const getRangeFilteredScreenshotsById: Selector<
    Map<string, Marker[]>
  > = createSelector(
    getMarkerGetter,
    getCommittedRangeFilteredMarkerIndexes,
    MarkerData.groupScreenshotsById
  );

  /**
   * This returns the marker index for the currently selected marker.
   */
  const getSelectedMarkerIndex: Selector<MarkerIndex | null> = state =>
    threadSelectors.getViewOptions(state).selectedMarker;

  /**
   * From the previous value, this returns the full marker object for the
   * selected marker.
   */
  const getSelectedMarker: Selector<Marker | null> = state => {
    const getMarker = getMarkerGetter(state);
    const selectedMarkerIndex = getSelectedMarkerIndex(state);

    if (selectedMarkerIndex === null) {
      return null;
    }

    return getMarker(selectedMarkerIndex);
  };

  const getRightClickedMarkerIndex: Selector<null | MarkerIndex> = createSelector(
    getRightClickedMarkerInfo,
    rightClickedMarkerInfo => {
      if (
        rightClickedMarkerInfo !== null &&
        rightClickedMarkerInfo.threadIndex === threadIndex
      ) {
        return rightClickedMarkerInfo.markerIndex;
      }

      return null;
    }
  );

  const getRightClickedMarker: Selector<null | Marker> = createSelector(
    getMarkerGetter,
    getRightClickedMarkerIndex,
    (getMarker, markerIndex) =>
      typeof markerIndex === 'number' ? getMarker(markerIndex) : null
  );

  return {
    getMarkerGetter,
    getJankMarkerIndexesForHeader,
    getProcessedRawMarkerTable,
    getDerivedMarkerInfo,
    getMarkerIndexToRawMarkerIndexes,
    getFullMarkerListIndexes,
    getNetworkMarkerIndexes,
    getSearchFilteredNetworkMarkerIndexes,
    getAreMarkerPanelsEmptyInFullRange,
    getMarkerChartMarkerIndexes,
    getSearchFilteredMarkerChartMarkerIndexes,
    getMarkerChartTimingAndBuckets,
    getCommittedRangeFilteredMarkerIndexes,
    getCommittedRangeAndTabFilteredMarkerIndexes,
    getCommittedRangeAndTabFilteredMarkerIndexesForHeader,
    getActiveTabFilteredMarkerIndexesWithoutGlobals,
    getTimelineVerticalMarkerIndexes,
    getFileIoMarkerIndexesForHeader,
    getMemoryMarkerIndexes,
    getIPCMarkerIndexes,
    getNetworkTrackTiming,
    getRangeFilteredScreenshotsById,
    getSearchFilteredMarkerIndexes,
    getPreviewFilteredMarkerIndexes,
    getSelectedMarkerIndex,
    getSelectedMarker,
    getIsNetworkChartEmptyInFullRange,
    getUserTimingMarkerIndexes,
    getUserTimingMarkerTiming,
    getRightClickedMarkerIndex,
    getRightClickedMarker,
  };
}
