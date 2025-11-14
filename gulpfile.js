var gulp = require('gulp'),
	plumber = require('gulp-plumber'),
	browserSync = require('browser-sync'),
	stylus = require('gulp-stylus'),
	uglify = require('gulp-uglify'),
	concat = require('gulp-concat'),
	jeet = require('jeet'),
	rupture = require('rupture'),
	koutoSwiss = require('kouto-swiss'),
	prefixer = require('autoprefixer-stylus'),
	imagemin = require('gulp-imagemin'),
	cp = require('child_process'),
	imageResize = require('gulp-image-resize'); // Added gulp-image-resize

var messages = {
	jekyllBuild: '<span style="color: grey">Running:</span> $ jekyll build'
};

var jekyllCommand = (/^win/.test(process.platform)) ? 'jekyll.bat' : 'bundle';
var jekyllArgs = (/^win/.test(process.platform)) ? ['build'] : ['exec', 'jekyll', 'build'];

/**
 * Build the Jekyll Site
 */
gulp.task('build', function (done) {
	browserSync.notify(messages.jekyllBuild);
	return cp.spawn(jekyllCommand, jekyllArgs, { stdio: 'inherit' })
		.on('close', done);
});

/**
 * Rebuild Jekyll & do page reload
 */
gulp.task('rebuild', ['build'], function () {
	browserSync.reload();
});

/**
 * Wait for build, then launch the Server
 */
gulp.task('browser-sync', ['build'], function () {
	browserSync({
		server: {
			baseDir: '_site'
		}
	});
});

/**
 * Stylus task
 */
gulp.task('stylus', function () {
	gulp.src('src/styl/main.styl')
		.pipe(plumber())
		.pipe(stylus({
			use: [koutoSwiss(), prefixer(), jeet(), rupture()],
			compress: true
		}))
		.pipe(gulp.dest('_site/assets/css/'))
		.pipe(gulp.dest('assets/css'))
		.pipe(browserSync.reload({ stream: true }))
});

/**
 * Javascript Task
 */
gulp.task('js', function () {
	return gulp.src('src/js/**/*.js')
		.pipe(plumber())
		.pipe(concat('main.js'))
		.pipe(uglify())
		.pipe(gulp.dest('assets/js/'))
});

/**
 * Imagemin Task
 */
gulp.task('imagemin', function () {
	return gulp.src(['src/images/**/*.{jpg,png,gif,ico}', '!src/images/**/preview.{jpg,png,gif,ico}'])
		.pipe(plumber())
		.pipe(imagemin({ optimizationLevel: 3, progressive: true, interlaced: true }))
		.pipe(gulp.dest('assets/images/'));
});

/**
 * Preview Resizer Task
 */
gulp.task('preview-resizer', function () {
	return gulp.src('src/images/**/preview.{jpg,png,gif,ico}')
		.pipe(plumber())
		.pipe(imageResize({
			width: 1200,
			height: 630,
			crop: true,
			gravity: 'Center',
			upscale: false
		}))
		.pipe(gulp.dest('assets/images/'));
});

/**
 * Watch stylus files for changes & recompile
 * Watch html/md files, run jekyll & reload BrowserSync
 */
gulp.task('watch', function () {
	gulp.watch('src/styl/**/*.styl', ['stylus']);
	gulp.watch('src/js/**/*.js', ['js']);
	gulp.watch('src/images/**/*.{jpg,png,gif}', ['imagemin', 'preview-resizer']);
	gulp.watch([
		'*.html',
		'_includes/*.html',
		'_layouts/*.html',
		'_posts/*',
		'_data/*',
		'_plugins/*',
		'pages/*'
	], ['rebuild']);
});


/**
 * Default task, running just `gulp` will compile the sass,
 * compile the jekyll site, launch BrowserSync & watch files.
 */
gulp.task('default', ['js', 'stylus', 'imagemin', 'preview-resizer', 'browser-sync', 'watch']);
