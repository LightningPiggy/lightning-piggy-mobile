import type { TextInputInstance } from 'react-native';
import React, { useState, useCallback, useMemo, useRef, useDeferredValue, useEffect } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, TextInput } from 'react-native';
import TabHeader from '../components/TabHeader';
import BrandPatternBackground from '../components/BrandPatternBackground';
import { useFocusEffect } from '@react-navigation/native';
import { courses, type Course } from '../data/learnContent';
import {
  getProgress,
  LearnProgress,
  getCourseCompletedCount,
  isCourseComplete,
} from '../services/learnProgressService';
import { Check, ChevronLeft, Search, X } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createLearnScreenStyles } from '../styles/LearnScreen.styles';

import { ExploreNavigation } from '../navigation/types';

interface Props {
  navigation: ExploreNavigation;
}

/**
 * Returns true when the lower-cased query appears as a substring in any of
 * the course/mission text fields users would expect to match: course title +
 * description, plus every nested mission's title + description. Match is
 * case-insensitive and substring-based — sufficient for the current catalog
 * size (see issue #151 — out of scope: full-text indexing / ranking).
 */
const courseMatches = (course: Course, lowerQuery: string): boolean => {
  if (course.title.toLowerCase().includes(lowerQuery)) return true;
  if (course.description.toLowerCase().includes(lowerQuery)) return true;
  return course.missions.some(
    (m) =>
      m.title.toLowerCase().includes(lowerQuery) ||
      m.description.toLowerCase().includes(lowerQuery),
  );
};

const LessonsScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  // First-render marker: fires once per mount when the first commit lands. Used by scripts/perf-startup.sh to measure tap-to-render latency for the Lessons sub-screen reached via tab-explore → ExploreHome → Lessons.
  const lessonsRenderLoggedRef = useRef(false);
  useEffect(() => {
    if (lessonsRenderLoggedRef.current) return;
    lessonsRenderLoggedRef.current = true;
    console.log(`[Perf] LessonsScreen first render`);
  }, []);
  const styles = useMemo(() => createLearnScreenStyles(colors), [colors]);
  const [progress, setProgress] = useState<LearnProgress>({ completedMissions: [] });
  const [search, setSearch] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<TextInputInstance>(null);

  // Defer the value driving the filter so typing stays responsive on the
  // input itself even if the filter step grows later. Mirrors FriendsScreen.
  const deferredSearch = useDeferredValue(search);

  useFocusEffect(
    useCallback(() => {
      getProgress().then(setProgress);
    }, []),
  );

  const filteredCourses = useMemo(() => {
    const lower = deferredSearch.trim().toLowerCase();
    if (!lower) return courses;
    return courses.filter((c) => courseMatches(c, lower));
  }, [deferredSearch]);

  const closeSearch = useCallback(() => {
    setSearch('');
    setSearchExpanded(false);
  }, []);

  // AppNavigator uses freezeOnBlur:true (no unmountOnBlur), so React state survives tab switches. Reset the search UI on blur so navigating away and back returns to the all-courses default — matches the AC for #151.
  useFocusEffect(
    useCallback(
      () => () => {
        closeSearch();
      },
      [closeSearch],
    ),
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.headerBackground}>
        <BrandPatternBackground variant="explore-compass" />
        <TabHeader
          title={t('lessonsScreen.title')}
          icon={<ChevronLeft size={20} color={colors.brandPink} strokeWidth={2.5} />}
          onIconPress={() => navigation.goBack()}
          iconAccessibilityLabel={t('lessonsScreen.backToExplore')}
        />
        <View style={styles.headerExtras}>
          {searchExpanded ? (
            <View style={styles.searchRow}>
              <Search size={16} color="rgba(255,255,255,0.7)" strokeWidth={2} />
              <TextInput
                ref={searchInputRef}
                style={styles.searchInput}
                placeholder={t('lessonsScreen.searchPlaceholder')}
                placeholderTextColor="rgba(255,255,255,0.5)"
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t('lessonsScreen.searchCourses')}
                testID="learn-search-input"
              />
              <TouchableOpacity
                onPress={closeSearch}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('lessonsScreen.closeSearch')}
                testID="learn-close-search"
              >
                <X size={16} color="rgba(255,255,255,0.8)" strokeWidth={2.5} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.searchToggleRow}>
              <TouchableOpacity
                style={styles.searchToggle}
                onPress={() => {
                  setSearchExpanded(true);
                  setTimeout(() => searchInputRef.current?.focus(), 100);
                }}
                accessibilityLabel={t('lessonsScreen.searchCourses')}
                testID="learn-search-toggle"
              >
                <Search size={18} color="rgba(255,255,255,0.8)" strokeWidth={2} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {/* Course grid */}
      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.grid}>
        {filteredCourses.length === 0 ? (
          <View style={styles.emptyState} testID="learn-empty-state">
            <Text style={styles.emptyTitle}>
              {t('lessonsScreen.noCoursesMatch', { query: deferredSearch.trim() })}
            </Text>
            <Text style={styles.emptySubtitle}>{t('lessonsScreen.tryDifferentTerm')}</Text>
            <TouchableOpacity
              style={styles.clearSearchButton}
              onPress={closeSearch}
              accessibilityLabel={t('lessonsScreen.clearSearch')}
              testID="learn-clear-search"
            >
              <Text style={styles.clearSearchButtonText}>{t('lessonsScreen.clearSearch')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          filteredCourses.map((course) => {
            const missionIds = course.missions.map((m) => m.id);
            const completed = getCourseCompletedCount(progress, missionIds);
            const total = course.missions.length;
            const allDone = isCourseComplete(progress, missionIds);

            return (
              <TouchableOpacity
                key={course.id}
                style={styles.courseCard}
                onPress={() => navigation.navigate('CourseDetail', { courseId: course.id })}
                activeOpacity={0.8}
              >
                <View style={styles.imageWrapper}>
                  <Image source={course.image} style={styles.courseImage} resizeMode="cover" />
                  {allDone && (
                    <View style={styles.completeBadge}>
                      <Check size={16} color="#FFFFFF" />
                    </View>
                  )}
                </View>
                <Text style={styles.courseTitle} numberOfLines={2}>
                  {course.title}
                </Text>
                <Text style={styles.courseMeta}>
                  {t('lessonsScreen.missionsCount', { count: total })}
                </Text>
                <View style={styles.chipSpacer} />
                {allDone ? (
                  <View style={styles.chipEarned}>
                    <Text style={styles.chipEarnedText}>{t('lessonsScreen.completed')}</Text>
                  </View>
                ) : completed > 0 ? (
                  <View style={styles.chipProgress}>
                    <Text style={styles.chipProgressText}>
                      {t('lessonsScreen.progressDone', { completed, total })}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.chipNew}>
                    <Text style={styles.chipNewText}>{t('lessonsScreen.start')}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );
};

export default LessonsScreen;
