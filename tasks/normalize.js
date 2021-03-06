'use strict';

module.exports = function (grunt) {
  grunt.registerMultiTask('normalize', function () {
    var options = this.options();

    var path = require('path');
    var _ = require('lodash');
    var moment = require('moment');
    var helpers = require('./helpers');

    _.str = require('underscore.string');
    _.mixin(_.str.exports());

    var basePath = path.join(options.srcFolder, options.academicYear.replace('/', '-'), options.semester);
    var consolidatePath = path.join(basePath, grunt.config('consolidate').options.destFileName);
    var lessonTypesPath = path.join(options.srcFolder, grunt.config('cors').options.destLessonTypes);
    var consolidated = grunt.file.readJSON(consolidatePath);
    var lessonTypes = grunt.file.readJSON(lessonTypesPath);

    var nullPattern = /^(--|n[/.]?a\.?|nil|none\.?|null|No Exam Date\.|)$/i;

    var facultyDepartments = {};
    var venues = {};

    var dayTextToCode = {
      MONDAY: '1',
      TUESDAY: '2',
      WEDNESDAY: '3',
      THURSDAY: '4',
      FRIDAY: '5',
      SATURDAY: '6',
      SUNDAY: '7'
    };

    var titleize = function(str) {
      return str.toLowerCase()
        .replace(/(?:^|\s\(?|-|\/)\S/g, function(c){ return c.toUpperCase(); })
        .replace(/\bIp\b/, 'IP')
        .replace(/\bMit\b/, 'MIT')
        .replace(/^Na$/, 'NA')
        .replace(/\bNus\b/, 'NUS');
    };

    var modules = _.compact(_.map(consolidated, function (rawMod) {
      var modInfo = rawMod.Bulletin || rawMod.CORS;
      if (modInfo) {
        var mod = _.pick(modInfo, 'ModuleCode', 'ModuleTitle', 'Department',
          'ModuleDescription', 'CrossModule', 'ModuleCredit', 'Workload',
          'Prerequisite', 'Preclusion', 'Corequisite');
        _.each(mod, function (value, key) {
          value = mod[key] = _.clean(value);
          if (key !== 'Department' && nullPattern.test(value)) {
            delete mod[key];
          }
        });

        // Only titleize if title is all caps.
        if (mod.ModuleTitle.toUpperCase() === mod.ModuleTitle) {
          mod.ModuleTitle = titleize(mod.ModuleTitle);
        }
        mod.Department = titleize(mod.Department);

        if (rawMod.Bulletin) {
          var faculty = titleize(modInfo.Faculty);
          facultyDepartments[faculty] = facultyDepartments[faculty] || {};
          facultyDepartments[faculty][mod.Department] = true;
        }

        var exam = rawMod.Exam;
        if (exam) {
          mod.ExamDate = moment.utc(exam.Date.slice(0, 11) + exam.Time,
            'DD/MM/YYYY h:mm a').toISOString().slice(0, 16) + '+0800';
          if (exam[''] === '*') {
            mod.ExamOpenBook = true;
          }
          if (exam.Duration) {
            mod.ExamDuration = 'P' + exam.Duration.replace(/\s/g, '').toUpperCase().slice(0, 5);
          }
          if (exam.Venue) {
            mod.ExamVenue = exam.Venue;
          }
        } else if (rawMod.CORS) {
          exam = rawMod.CORS.ExamDate;
          if (exam !== 'No Exam Date.') {
            var dateTime = rawMod.CORS.ExamDate.split(' ');
            var date = moment.utc(dateTime[0], 'DD-MM-YYYY');
            switch (dateTime[1]) {
              case 'AM':
                date.hour(9);
                break;
              case 'PM':
                // 2.30 PM on Friday afternoons
                if (date.day() === 5) {
                  date.hour(14).minute(30);
                } else {
                  date.hour(13);
                }
                break;
              case 'EVENING':
                date.hour(17);
                break;
              default:
                grunt.fail.warn('Unexpected exam time ' + dateTime[1]);
            }
            mod.ExamDate = date.toISOString().slice(0, 16) + '+0800';
          }
        }

        if (rawMod.CORS) {
          mod.Types = rawMod.CORS.Types;
        }

        if (rawMod.IVLE) {
          if (rawMod.IVLE[0]) {
            var lecturers = [];
            rawMod.IVLE[0].Lecturers.forEach(function (lecturer) {
              switch (lecturer.Role.trim()) {
                case 'Lecturer':
                case 'Co-Lecturer':
                case 'Visiting Professor':
                  lecturers.push(lecturer.User.Name);
              }
            });
            if (!_.isEmpty(lecturers)) {
              mod.Lecturers = lecturers;
            }
          }
          mod.IVLE = rawMod.IVLE;
        }

        if (rawMod.CORS && rawMod.CORS.Timetable.length) {
          mod.Timetable = rawMod.CORS.Timetable.map(function (lesson) {
            lesson.WeekText = lesson.WeekText.replace('&nbsp;', ' ');
            lesson.DayCode = dayTextToCode[lesson.DayText];
            lesson.Venue = lesson.Venue.replace(/(?:^null)?,$/, '');
            return lesson;
          });
        } else {
          _.each(rawMod.TimetableDelta, function (delta) {
            // Ignore Sundays - they seem to be dummy values.
            if (delta.DayCode === '7') {
              return;
            }

            var timetable = mod.Timetable = mod.Timetable || [];
            var originalLength = timetable.length;
            for (var i = originalLength; i--;) {
              var lesson = timetable[i];
              if (lesson.ClassNo === delta.ClassNo &&
                lesson.LessonType === delta.LessonType &&
                lesson.WeekText === delta.WeekText &&
                lesson.DayCode === delta.DayCode &&
                lesson.StartTime === delta.StartTime &&
                lesson.EndTime === delta.EndTime) {
                if (lesson.Venue === delta.Venue || (!delta.isDelete &&
                  lesson.LastModified_js !== delta.LastModified_js)) {
                  timetable.splice(i, 1);
                }
              }
            }
            var lessonsDeleted = originalLength - timetable.length;
            if (delta.isDelete) {
              if (lessonsDeleted !== 1) {
                grunt.verbose.writeln(lessonsDeleted + ' lessons deleted for ' + modInfo.ModuleCode);
              }
              if (timetable.length === 0) {
                grunt.verbose.writeln('No more lessons for ' + modInfo.ModuleCode);
                delete mod.Timetable;
              }
            } else {
              if (lessonsDeleted > 0) {
                grunt.verbose.writeln('Duplicate lesson deleted for ' + modInfo.ModuleCode);
              }
              timetable.push(_.pick(delta, 'ClassNo', 'LessonType', 'WeekText', 'DayCode',
                'DayText', 'StartTime', 'EndTime', 'Venue', 'LastModified_js'));
            }
          });
        }

        if (rawMod.CorsBiddingStats) {
          mod.CorsBiddingStats = _.map(rawMod.CorsBiddingStats, function (stats) {
            stats = _.omit(stats, 'ModuleCode');
            stats.Group = titleize(stats.Group);
            stats.Faculty = titleize(stats.Faculty);
            stats.StudentAcctType = stats.StudentAcctType.replace('<br>', '');
            return stats;
          });
        }

        if (mod.Timetable) {
          var periods = {Lecture: {}, Tutorial: {}};
          mod.Timetable.forEach(function (lesson) {
            lesson.DayText = titleize(lesson.DayText);
            lesson.StartTime = ('000' + lesson.StartTime).slice(-4);

            var period;
            if (lesson.StartTime < '1200') {
              period = 'Morning';
            } else if (lesson.StartTime < '1800') {
              period = 'Afternoon';
            } else {
              period = 'Evening';
            }
            periods[lessonTypes[lesson.LessonType]][lesson.DayText + ' ' + period] = true;

            lesson.LessonType = titleize(lesson.LessonType);
            lesson.WeekText = titleize(lesson.WeekText);
            lesson.EndTime = ('000' + lesson.EndTime).slice(-4);
            lesson.Venue = lesson.Venue.trim();
            venues[lesson.Venue] = true;
          });
          if (!_.isEmpty(periods.Lecture)) {
            mod.LecturePeriods = _.keys(periods.Lecture);
          }
          if (!_.isEmpty(periods.Tutorial)) {
            mod.TutorialPeriods = _.keys(periods.Tutorial);
          }

          var lessonSortOrder = ['LessonType', 'ClassNo', 'DayCode', 'StartTime',
            'EndTime', 'WeekText', 'Venue'];
          mod.Timetable.sort(function (a, b) {
            for (var i = 0; i < lessonSortOrder.length; i++) {
              var key = lessonSortOrder[i];
              if (a[key] !== b[key]) {
                return a[key] > b[key] ? 1 : -1;
              }
            }
            return 0;
          });

          mod.Timetable.forEach(function (lesson) {
            delete lesson.DayCode;
            delete lesson.LastModified_js;
          });
        }

        return mod;
      }
    }));

    _.each(facultyDepartments, function (departments, faculty) {
      facultyDepartments[faculty] = Object.keys(departments).sort();
    });

    grunt.file.write(
      path.join(basePath, options.destFacultyDepartments),
      JSON.stringify(helpers.sortByKey(facultyDepartments), null, options.jsonSpace)
    );

    venues = _.omit(venues, ''); // Omit empty keys
    var venuesList = _.keys(venues);
    venuesList.sort();
    
    grunt.file.write(
      path.join(basePath, options.destVenues),
      JSON.stringify(venuesList, null, options.jsonSpace)
    );

    grunt.file.write(
      path.join(basePath, options.destFileName),
      JSON.stringify(modules, null, options.jsonSpace)
    );
  });
};
